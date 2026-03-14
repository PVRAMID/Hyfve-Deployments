const express = require('express');
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const DOMAIN = process.env.DOMAIN_NAME || 'mydomain.com';
const PROXY_NETWORK = process.env.PROXY_NETWORK || 'proxy';
const API_KEY = process.env.API_KEY;

// --- Active Deployments (SSE Log Streaming) ---
// Map<deployId, { repoName, cloneUrl, status, emitter, logs[] }>
const activeDeployments = new Map();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_NUMBER = process.env.TELEGRAM_ALLOWED_NUMBER;

if (!SECRET) {
  console.error("CRITICAL: GITHUB_WEBHOOK_SECRET is not set. Exiting.");
  process.exit(1);
}

if (!TELEGRAM_TOKEN || !TELEGRAM_ALLOWED_NUMBER) {
  console.error("CRITICAL: Telegram environment variables are missing. Exiting.");
  process.exit(1);
}

// Telegram Initialization
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const DB_FILE = path.join('/tmp', 'repos', 'telegram_admin.json');
let adminChatId = null;

if (fs.existsSync(DB_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE));
    adminChatId = data.adminChatId;
    console.log(`Loaded persistent adminChatId: ${adminChatId}`);
  } catch(e) {
    console.error("Failed to load telegram admin db:", e);
  }
}

const saveAdmin = (id) => {
  adminChatId = id;
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify({ adminChatId: id }));
};

const sendTelegram = (text, options = {}) => {
  if (adminChatId) {
    bot.sendMessage(adminChatId, text, options).catch(err => console.error("Telegram send error:", err.message));
  } else {
    console.log("No admin authenticated yet via Telegram. Cannot send message:", text);
  }
};

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  
  if (msg.text === '/start') {
    if (adminChatId === chatId) {
      bot.sendMessage(chatId, "You are already authorized for deployments.");
      return;
    }
    const opts = {
      reply_markup: {
        keyboard: [
          [{ text: "Share My Phone Number", request_contact: true }]
        ],
        one_time_keyboard: true,
        resize_keyboard: true
      }
    };
    bot.sendMessage(chatId, "Welcome to the Deploy Bot! Please tap the button below to share your contact so I can verify you.", opts);
  } else if (msg.contact) {
    const userPhoneTail = msg.contact.phone_number.replace(/\D/g, '').slice(-10);
    const allowedPhoneTail = TELEGRAM_ALLOWED_NUMBER.replace(/\D/g, '').slice(-10);

    // Verify contact belongs to the sender
    if (msg.contact.user_id && msg.contact.user_id !== msg.from.id) {
       bot.sendMessage(chatId, "Please share your *own* contact data using the keyboard button.", { parse_mode: 'Markdown' });
       return;
    }

    if (userPhoneTail === allowedPhoneTail) {
      saveAdmin(chatId);
      bot.sendMessage(chatId, "Authentication successful! You will now receive deployment prompts here.", {
        reply_markup: { remove_keyboard: true }
      });
    } else {
      bot.sendMessage(chatId, "Unauthorized phone number. Access denied.", {
        reply_markup: { remove_keyboard: true }
      });
    }
  }
});

const pendingDeployments = new Map();

bot.on('callback_query', (query) => {
  const data = query.data;
  const message = query.message;

  if (message.chat.id !== adminChatId) return;

  if (data.startsWith('deploy_')) {
     const deployId = data.replace('deploy_', '');
     const deployInfo = pendingDeployments.get(deployId);
     if (deployInfo) {
       pendingDeployments.delete(deployId);
       bot.editMessageText(`🚀 Deployment *started* for ${deployInfo.repoName}...\n_I will keep you updated on the progress._`, {
          chat_id: adminChatId,
          message_id: message.message_id,
          parse_mode: 'Markdown'
       });
       deploy(deployInfo.repoName, deployInfo.cloneUrl);
     } else {
       bot.sendMessage(adminChatId, "This deployment request has expired.");
     }
  } else if (data.startsWith('cancel_')) {
     const deployId = data.replace('cancel_', '');
     const deployInfo = pendingDeployments.get(deployId);
     if (deployInfo) {
       pendingDeployments.delete(deployId);
       bot.editMessageText(`❌ Deployment *cancelled* for ${deployInfo.repoName}.`, {
          chat_id: adminChatId,
          message_id: message.message_id,
          parse_mode: 'Markdown'
       });
     }
  }
  
  bot.answerCallbackQuery(query.id);
});

const captureRawBody = (req, res, buf, encoding) => {
  if (buf && buf.length) {
    req.rawBody = buf;
  }
};

// Middleware to capture the raw body for accurate HMAC signature verification
app.use(express.json({ verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, verify: captureRawBody }));

app.post('/webhook', (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];

  if (!signature) {
    return res.status(401).send('No signature provided');
  }

  if (!req.rawBody) {
    console.error('Webhook error: req.rawBody is missing. Ensure GitHub is sending a payload.');
    return res.status(400).send('Invalid payload framework. Expected body data.');
  }

  const hmac = crypto.createHmac('sha256', SECRET);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

  if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest)) === false) {
    console.error('Webhook signature verification failed');
    return res.status(403).send('Invalid signature');
  }

  if (event !== 'push') {
    return res.status(200).send('Ignoring non-push event');
  }

  // Handle application/x-www-form-urlencoded vs application/json
  let payload = req.body;
  if (req.headers['content-type'] === 'application/x-www-form-urlencoded') {
    try {
      payload = JSON.parse(req.body.payload);
    } catch (e) {
      console.error('Failed to parse URL-encoded payload:', e);
      return res.status(400).send('Invalid JSON in URL-encoded payload');
    }
  }

  const ref = payload.ref;
  
  const prodBranch = process.env.PRODUCTION_BRANCH || 'refs/heads/main';
  if (ref !== prodBranch) {
    console.log(`Ignoring push to ${ref}. Only ${prodBranch} triggers a deployment.`);
    return res.status(200).send(`Ignoring push to ${ref}`);
  }

  const repoName = payload.repository.name;
  const cloneUrl = payload.repository.clone_url; 

  console.log(`\n--- NEW PUSH TRIGGGERED ---`);
  console.log(`Repository: ${repoName}`);

  res.status(202).send('Push received, prompting admin on Telegram');

  if (!adminChatId) {
     console.log("Cannot prompt via Telegram: No admin authenticated yet.");
     return;
  }

  const deployId = crypto.randomUUID();
  pendingDeployments.set(deployId, { repoName, cloneUrl });

  const opts = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Deploy', callback_data: `deploy_${deployId}` },
          { text: '❌ Cancel', callback_data: `cancel_${deployId}` }
        ]
      ]
    }
  };

  const author = payload.pusher ? payload.pusher.name : "Someone";
  const commitMsg = payload.head_commit ? payload.head_commit.message : "No message provided";

  sendTelegram(`🔔 New Push Detected!\n\nRepository: ${repoName}\nBranch: ${prodBranch.replace('refs/heads/', '')}\nPushed by: ${author}\n\nMessage: ${commitMsg}\n\nWould you like to deploy this update?`, opts);
});

// =============================================
//   REST API — Desktop App Integration Layer
// =============================================

const requireApiKey = (req, res, next) => {
  if (!API_KEY) {
    return res.status(503).json({ error: 'API_KEY is not configured on the server.' });
  }
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key.' });
  }
  next();
};

// Health check — also used by desktop to test connection
app.get('/api/health', requireApiKey, (req, res) => {
  res.json({ status: 'ok', domain: DOMAIN, timestamp: Date.now() });
});

// List deployed containers + their status
app.get('/api/apps', requireApiKey, async (req, res) => {
  try {
    const stdout = await runCommandSilent(
      `docker ps -a --filter "network=${PROXY_NETWORK}" --format '{{json .}}'`
    );
    const containers = stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean)
      // Exclude infrastructure containers (traefik, webhook-listener)
      .filter(c => !['traefik', 'webhook-listener'].includes(c.Names))
      .map(c => ({
        id: c.Names,
        name: c.Names,
        containerName: c.Names,
        image: c.Image,
        description: `${c.Image} · ${c.Status}`,
        status: c.State === 'running' ? 'Running' : c.State === 'exited' ? 'Error' : 'Available',
        liveUrl: `https://${c.Names}.${DOMAIN}`,
        ports: c.Ports || ''
      }));

    res.json({ apps: containers, domain: DOMAIN });
  } catch (err) {
    console.error('API /api/apps error:', err.message);
    res.status(500).json({ error: 'Failed to list containers.', details: err.message });
  }
});

// Trigger a new deployment (bypasses Telegram approval — desktop is a trusted admin)
app.post('/api/deploy', requireApiKey, (req, res) => {
  const { repoName, cloneUrl } = req.body;

  if (!repoName || !cloneUrl) {
    return res.status(400).json({ error: 'repoName and cloneUrl are required.' });
  }

  const deployId = crypto.randomUUID();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(10);

  activeDeployments.set(deployId, {
    repoName,
    cloneUrl,
    status: 'started',
    emitter,
    logs: []
  });

  // Notify Telegram as a heads-up (no approval needed)
  sendTelegram(`🖥️ Desktop deployment triggered for *${repoName}*...`, { parse_mode: 'Markdown' });

  // Start deployment asynchronously with log streaming
  deployWithLogs(deployId, repoName, cloneUrl);

  res.status(202).json({ deployId, message: `Deployment started for ${repoName}` });
});

// SSE endpoint — stream real-time deployment logs
app.get('/api/deploy/:id/logs', requireApiKey, (req, res) => {
  const deployId = req.params.id;
  const deployInfo = activeDeployments.get(deployId);

  if (!deployInfo) {
    return res.status(404).json({ error: 'Deployment not found or expired.' });
  }

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send any logs that already accumulated
  for (const entry of deployInfo.logs) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  // If already finished, close immediately
  if (deployInfo.status === 'done' || deployInfo.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'end', status: deployInfo.status })}\n\n`);
    return res.end();
  }

  // Stream new logs as they arrive
  const onLog = (entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };
  const onEnd = (finalStatus) => {
    res.write(`data: ${JSON.stringify({ type: 'end', status: finalStatus })}\n\n`);
    res.end();
  };

  deployInfo.emitter.on('log', onLog);
  deployInfo.emitter.once('end', onEnd);

  // Cleanup if client disconnects
  req.on('close', () => {
    deployInfo.emitter.removeListener('log', onLog);
    deployInfo.emitter.removeListener('end', onEnd);
  });
});

// Get status of a specific container
app.get('/api/status/:name', requireApiKey, async (req, res) => {
  const containerName = req.params.name;
  try {
    const stdout = await runCommandSilent(`docker inspect ${containerName} --format '{{json .State}}'`);
    const state = JSON.parse(stdout.trim());
    res.json({
      containerName,
      status: state.Status,
      running: state.Running,
      startedAt: state.StartedAt,
      finishedAt: state.FinishedAt,
      exitCode: state.ExitCode,
      liveUrl: `https://${containerName}.${DOMAIN}`
    });
  } catch (err) {
    res.status(404).json({ error: `Container '${containerName}' not found.`, details: err.message });
  }
});

// =============================================
//   Core Deployment Engine
// =============================================

const { spawn } = require('child_process');

// Silent command runner (no streaming, used by API queries)
function runCommandSilent(command, cwd = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true });
    let stdoutData = '';
    let stderrData = '';
    child.stdout.on('data', (data) => { stdoutData += data.toString(); });
    child.stderr.on('data', (data) => { stderrData += data.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Command failed with code ${code}: ${stderrData}`));
      resolve(stdoutData.trim());
    });
  });
}

// Streaming command runner (logs to console + optional emitter for SSE)
function runCommand(command, cwd = null, emitter = null) {
  return new Promise((resolve, reject) => {
    console.log(`[EXEC] ${command}`);
    
    const child = spawn(command, { cwd, shell: true });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdoutData += chunk;
      process.stdout.write(chunk);
      if (emitter) emitter.emit('log', { type: 'stdout', text: chunk, ts: Date.now() });
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrData += chunk;
      process.stderr.write(chunk);
      if (emitter) emitter.emit('log', { type: 'stderr', text: chunk, ts: Date.now() });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Command failed with code ${code}: ${stderrData}`));
      }
      resolve(stdoutData.trim());
    });
  });
}

// Deploy function used by Telegram webhook flow (original behavior, no emitter)
async function deploy(repoName, cloneUrl) {
  return deployCore(repoName, cloneUrl, null);
}

// Deploy function used by Desktop API (streams logs via emitter)
async function deployWithLogs(deployId, repoName, cloneUrl) {
  const deployInfo = activeDeployments.get(deployId);
  const emitter = deployInfo ? deployInfo.emitter : null;

  const pushLog = (text) => {
    const entry = { type: 'info', text, ts: Date.now() };
    if (deployInfo) deployInfo.logs.push(entry);
    if (emitter) emitter.emit('log', entry);
  };

  try {
    await deployCore(repoName, cloneUrl, emitter, pushLog);
    if (deployInfo) deployInfo.status = 'done';
    if (emitter) emitter.emit('end', 'done');
  } catch (err) {
    if (deployInfo) deployInfo.status = 'error';
    if (emitter) emitter.emit('end', 'error');
  }

  // Cleanup after 10 minutes
  setTimeout(() => activeDeployments.delete(deployId), 10 * 60 * 1000);
}

async function deployCore(repoName, cloneUrl, emitter = null, pushLog = null) {
  const workDir = path.join('/tmp', 'repos');
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
  }

  const repoDir = path.join(workDir, repoName);
  const branchName = (process.env.PRODUCTION_BRANCH || 'refs/heads/main').replace('refs/heads/', '');

  const logToTg = (msg) => {
     console.log(msg);
     sendTelegram(`[${repoName}]: ${msg}`);
     if (pushLog) pushLog(msg);
  };

  try {
    let authenticatedCloneUrl = cloneUrl;
    if (process.env.GITHUB_TOKEN) {
      authenticatedCloneUrl = cloneUrl.replace('https://', `https://${process.env.GITHUB_TOKEN}@`);
    }

    if (fs.existsSync(repoDir)) {
      logToTg("🔄 Pulling latest changes...");
      await runCommand(`git fetch`, repoDir, emitter);
      await runCommand(`git checkout ${branchName}`, repoDir, emitter);
      await runCommand(`git reset --hard origin/${branchName}`, repoDir, emitter); 
    } else {
      logToTg("📥 Cloning repository...");
      await runCommand(`git clone -b ${branchName} ${authenticatedCloneUrl} ${repoName}`, workDir, emitter);
    }

    if (!fs.existsSync(path.join(repoDir, 'Dockerfile'))) {
      throw new Error("No `Dockerfile` found in the repository root. Cannot build Image.");
    }

    const imageName = `${repoName}-image`;
    logToTg(`🔨 Building Docker image (this may take a few minutes)...`);
    
    try {
        await runCommand(`docker build -t ${imageName} .`, repoDir, emitter);
    } catch (buildError) {
        throw new Error(`Docker build failed:\n\n${buildError.message.slice(0, 3000)}`);
    }

    const containerName = `${repoName}-app`;
    logToTg(`🛑 Stopping old container...`);
    try {
      await runCommand(`docker rm -f ${containerName}`, null, emitter);
    } catch (e) {
      console.log('No old container to remove.');
    }

    logToTg(`🚀 Starting new instance attached to Traefik...`);
    const routerName = repoName.replace(/[^a-zA-Z0-9-]/g, ''); 
    const externalProxy = process.env.EXTERNAL_SSL_PROXY === 'true';
    
    let runCmd = `docker run -d -P --name ${containerName} \\
      --network ${PROXY_NETWORK} \\
      --label "traefik.enable=true" \\
      --label "traefik.http.routers.${routerName}.rule=Host(\\\`${repoName}.${DOMAIN}\\\`)" `;

    if (externalProxy) {
      runCmd += `\\
      --label "traefik.http.routers.${routerName}.entrypoints=web" \\
      ${imageName}`;
    } else {
      runCmd += `\\
      --label "traefik.http.routers.${routerName}.entrypoints=websecure" \\
      --label "traefik.http.routers.${routerName}.tls.certresolver=myresolver" \\
      ${imageName}`;
    }
      
    await runCommand(runCmd, null, emitter);
    
    // Fetch direct host port and public IP for debugging bypass
    let directLink = 'Not Available (App exposes no ports)';
    try {
      const publicIp = await runCommandSilent(`wget -qO- eth0.me || curl -sS ifconfig.me`);
      const portOut =  await runCommandSilent(`docker port ${containerName}`);
      
      const portMatch = portOut.match(/0\.0\.0\.0:(\d+)/) || portOut.match(/:::(\d+)/);
      if (portMatch && portMatch[1]) {
         directLink = `http://${publicIp.trim()}:${portMatch[1]}`;
      }
    } catch(e) {
      console.log('Failed to fetch direct IP port mapping', e);
    }

    const liveUrl = `https://${repoName}.${DOMAIN}`;
    logToTg(`✅ Successfully deployed!\n🌍 Domain: ${liveUrl}\n🛠 Direct: ${directLink}`);
    sendTelegram(`✅ *Successfully deployed ${repoName}!*\n\n🔗 [${liveUrl}](${liveUrl})\n🛠 ${directLink}`, { parse_mode: 'Markdown', disable_web_page_preview: true });

  } catch (err) {
    console.error(`\n[!] Error: ${err.message}`);
    sendTelegram(`❌ *Deployment failed for ${repoName}:*\n\n\`\`\`text\n${err.message}\n\`\`\``, { parse_mode: 'Markdown' });
    throw err; // Re-throw so deployWithLogs can catch it
  }
}

app.listen(PORT, () => {
  console.log(`Webhook listener initialized and listening on port ${PORT}`);
});
