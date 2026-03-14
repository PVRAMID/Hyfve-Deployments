const express = require('express');
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const DOMAIN = process.env.DOMAIN_NAME || 'mydomain.com';
const PROXY_NETWORK = process.env.PROXY_NETWORK || 'proxy';

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

const { spawn } = require('child_process');

function runCommand(command, cwd = null) {
  return new Promise((resolve, reject) => {
    console.log(`[EXEC] ${command}`);
    
    // Use spawn with shell true to stream output in real-time
    const child = spawn(command, { cwd, shell: true });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdoutData += chunk;
      process.stdout.write(chunk); // Stream to console
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderrData += chunk;
      process.stderr.write(chunk); // Stream to console
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Command failed with code ${code}: ${stderrData}`));
      }
      resolve(stdoutData.trim());
    });
  });
}

async function deploy(repoName, cloneUrl) {
  const workDir = path.join('/tmp', 'repos');
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
  }

  const repoDir = path.join(workDir, repoName);
  const branchName = (process.env.PRODUCTION_BRANCH || 'refs/heads/main').replace('refs/heads/', '');

  const logToTg = (msg) => {
     console.log(msg);
     sendTelegram(`[${repoName}]: ${msg}`);
  };

  try {
    let authenticatedCloneUrl = cloneUrl;
    if (process.env.GITHUB_TOKEN) {
      authenticatedCloneUrl = cloneUrl.replace('https://', `https://${process.env.GITHUB_TOKEN}@`);
    }

    if (fs.existsSync(repoDir)) {
      logToTg("🔄 *Pulling latest changes...*", { parse_mode: 'Markdown' });
      await runCommand(`git fetch`, repoDir);
      await runCommand(`git checkout ${branchName}`, repoDir);
      await runCommand(`git reset --hard origin/${branchName}`, repoDir); 
    } else {
      logToTg("📥 *Cloning repository...*", { parse_mode: 'Markdown' });
      await runCommand(`git clone -b ${branchName} ${authenticatedCloneUrl} ${repoName}`, workDir);
    }

    if (!fs.existsSync(path.join(repoDir, 'Dockerfile'))) {
      throw new Error("No `Dockerfile` found in the repository root. Cannot build Image.");
    }

    const imageName = `${repoName}-image`;
    logToTg(`🔨 *Building Docker image...*\n(_This step may take several minutes depending on dependencies_>`, { parse_mode: 'Markdown' });
    
    // We try/catch build so we can stream the massive stderr chunk back to telegram natively on fail
    try {
        await runCommand(`docker build -t ${imageName} .`, repoDir);
    } catch (buildError) {
        throw new Error(`Docker build failed:\n\n${buildError.message.slice(0, 3000)}`); // Telegram limits messages to 4096 chars
    }

    const containerName = `${repoName}-app`;
    logToTg(`🛑 *Stopping old container...*`, { parse_mode: 'Markdown' });
    try {
      await runCommand(`docker rm -f ${containerName}`);
    } catch (e) {
      console.log('No old container to remove.');
    }

    logToTg(`🚀 *Starting new instance attached to Traefik...*`, { parse_mode: 'Markdown' });
    const routerName = repoName.replace(/[^a-zA-Z0-9-]/g, ''); 
    const externalProxy = process.env.EXTERNAL_SSL_PROXY === 'true';
    
    let runCmd = `docker run -d -P --name ${containerName} \\
      --network ${PROXY_NETWORK} \\
      --label "traefik.enable=true" \\
      --label "traefik.http.routers.${routerName}.rule=Host(\\\`${repoName}.${DOMAIN}\\\`)" `;

    if (externalProxy) {
      // Disable HTTPS redirection and Let's Encrypt resolver - strictly listen internally on port 80/web
      runCmd += `\\
      --label "traefik.http.routers.${routerName}.entrypoints=web" \\
      ${imageName}`;
    } else {
      // Full standalone Render PaaS Mode - provision Let's Encrypt certificates natively
      runCmd += `\\
      --label "traefik.http.routers.${routerName}.entrypoints=websecure" \\
      --label "traefik.http.routers.${routerName}.tls.certresolver=myresolver" \\
      ${imageName}`;
    }
      
    await runCommand(runCmd);
    
    // Fetch direct host port and public IP for debugging bypass
    let directLink = 'Not Available (App exposes no ports)';
    try {
      const publicIp = await runCommand(`wget -qO- eth0.me || curl -sS ifconfig.me`);
      const portOut =  await runCommand(`docker port ${containerName}`);
      
      const portMatch = portOut.match(/0\.0\.0\.0:(\d+)/) || portOut.match(/:::(\d+)/);
      if (portMatch && portMatch[1]) {
         directLink = `http://${publicIp.trim()}:${portMatch[1]}`;
      }
    } catch(e) {
      console.log('Failed to fetch direct IP port mapping', e);
    }

    const liveUrl = `https://${repoName}.${DOMAIN}`;
    logToTg(`✅ *Successfully deployed!*\n\n🌍 *Domain URL:*\n🔗 [${liveUrl}](${liveUrl})\n\n🛠 *Direct IP (Bypass Proxy for Debugging):*\n🔗 ${directLink}`, { parse_mode: 'Markdown', disable_web_page_preview: true });

  } catch (err) {
    console.error(`\n[!] Error: ${err.message}`);
    sendTelegram(`❌ *Deployment failed for ${repoName}:*\n\n\`\`\`text\n${err.message}\n\`\`\``, { parse_mode: 'Markdown' });
  }
}

app.listen(PORT, () => {
  console.log(`Webhook listener initialized and listening on port ${PORT}`);
});
