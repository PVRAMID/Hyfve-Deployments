const readline = require('readline');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const net = require('net');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query, defaultVal) => {
  return new Promise(resolve => {
    rl.question(`\x1b[36m${query}\x1b[0m ${defaultVal ? `\x1b[90m(${defaultVal})\x1b[0m ` : ''}> `, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
};

const generateSecret = () => crypto.randomBytes(24).toString('hex');

async function runInstaller() {
  console.log('\n\x1b[35m=======================================\x1b[0m');
  console.log('\x1b[1m\x1b[32m  HYFVE Deploy Interactive Setup\x1b[0m');
  console.log('\x1b[36m  Developed by Joshua Lewis\x1b[0m');
  console.log('\x1b[35m=======================================\x1b[0m\n');

  console.log('This setup wizard will generate your \x1b[33m.env\x1b[0m file and configure HYFVE Deploy.\n');

  let existingConfig = {};
  if (fs.existsSync('.env')) {
    console.log('\x1b[32m[✓] Existing configuration found! Loading previous settings...\x1b[0m\n');
    const envFile = fs.readFileSync('.env', 'utf-8');
    envFile.split('\n').forEach(line => {
      const match = line.match(/^([^#\s=]+)=(.*)$/);
      if (match) {
        existingConfig[match[1]] = match[2];
      }
    });
  }

  const email = await askQuestion('Let\'s Encrypt Email Address (for SSL certificates):', existingConfig.EMAIL_ADDRESS || '');
  const domain = await askQuestion('Base Domain Name (e.g., mydomain.com):', existingConfig.DOMAIN_NAME || '');
  
  const defaultSecret = existingConfig.GITHUB_WEBHOOK_SECRET || generateSecret();
  console.log('\n\x1b[36m--- Security ---\x1b[0m');
  console.log('A Webhook Secret is a secure password that GitHub sends us to prove the request is actually from them.');
  console.log('We have auto-generated a very secure 48-character secret for you.');
  let secret = await askQuestion('GitHub Webhook Secret (Press Enter to keep the generated one):', defaultSecret);
  
  const branch = await askQuestion('Production Branch to listen to:', existingConfig.PRODUCTION_BRANCH || 'refs/heads/main');
  const githubToken = await askQuestion('GitHub Personal Access Token (Optional for Private Repos):', existingConfig.GITHUB_TOKEN || '');
  
  console.log('\n\x1b[36m--- Telegram Bot Configuration ---\x1b[0m');
  const tgToken = await askQuestion('Telegram Bot Token (From @BotFather):', existingConfig.TELEGRAM_BOT_TOKEN || '');
  const tgNumber = await askQuestion('Your Phone Number (e.g., +44 74 9402 6659):', existingConfig.TELEGRAM_ALLOWED_NUMBER || '');

  console.log('\n\x1b[36m--- Port Configuration & Pre-flight Checks ---\x1b[0m');
  let httpPort = existingConfig.TRAEFIK_HTTP_PORT || 80;
  let httpsPort = existingConfig.TRAEFIK_HTTPS_PORT || 443;
  let webhookPort = existingConfig.WEBHOOK_PORT || 3000;
  let externalProxy = existingConfig.EXTERNAL_SSL_PROXY === 'true';

  while (await isPortInUse(httpPort)) {
    if (!externalProxy) {
       console.log(`\n\x1b[33m[!] Port ${httpPort} is already in use by another service on this machine.\x1b[0m`);
       console.log('This often happens if you are running Nginx Proxy Manager or Apache.');
       const askProxy = await askQuestion('Are you using an external Reverse Proxy that will handle SSL certificates? (y/N):', 'N');
       if (askProxy.toLowerCase() === 'y' || askProxy.toLowerCase() === 'yes') {
          externalProxy = true;
          console.log('\x1b[32m[✓]\x1b[0m External proxy confirmed. We will bypass internal Let\'s Encrypt generation.');
          
          const automateNpm = await askQuestion('Would you like me to automatically configure Nginx Proxy Manager to securely route your Traefik deployments? (y/N):', 'N');
          if (automateNpm.toLowerCase() === 'y' || automateNpm.toLowerCase() === 'yes') {
            const npmUrl = await askQuestion('Nginx Proxy Manager API URL (usually http://127.0.0.1:81):', 'http://127.0.0.1:81');
            const npmEmail = await askQuestion('NPM Admin Email:');
            const npmPassword = await askQuestion('NPM Admin Password (Typed input will be visible):');
            
            try {
              console.log('\x1b[36mAuthenticating with NPM...\x1b[0m');
              const authRes = await fetch(`${npmUrl}/api/tokens`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identity: npmEmail, secret: npmPassword })
              });
              
              if (!authRes.ok) throw new Error('Authentication failed. Check your email or password.');
              const { token } = await authRes.json();
              
              console.log('\x1b[36mCreating wildcard Proxy Host...\x1b[0m');
              const hostRes = await fetch(`${npmUrl}/api/nginx/proxy-hosts`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                  domain_names: [`*.${domain || 'deployments.local'}`],
                  forward_scheme: "http",
                  forward_host: "172.17.0.1", // Docker bridge IP
                  forward_port: 8080, // We assume setup assigns 8080 or the user updates it manually if 8080 is also blocked.
                  allow_websocket_upgrade: true,
                  block_exploits: true,
                  caching_enabled: false,
                  meta: { letsencrypt_agree: false, dns_challenge: false }
                })
              });
              
              if (!hostRes.ok) {
                  const errorText = await hostRes.text();
                  throw new Error(`Failed to create proxy host: ${errorText}`);
              }
              
              console.log(`\x1b[32m[✓]\x1b[0m Proxy Host successfully injected into Nginx Proxy Manager!`);
              console.log(`\x1b[33mNote: You must still request the Wildcard SSL via your NPM Dashboard -> SSL Certificates.\x1b[0m\n`);
              
            } catch (err) {
              console.log(`\x1b[31m[!] Automated NPM setup failed: ${err.message}\x1b[0m`);
              console.log(`Please configure Nginx Proxy Manager manually later.\n`);
            }
          }
       }
    }
    
    console.log(`\x1b[33m[!] Please provide an alternative HTTP port since ${httpPort} is blocked.\x1b[0m`);
    httpPort = await askQuestion('Enter an alternative port for Traefik HTTP:', (parseInt(httpPort) + 8000).toString());
  }

  while (await isPortInUse(httpsPort)) {
    console.log(`\n\x1b[33m[!] Port ${httpsPort} is already in use on your system.\x1b[0m`);
    httpsPort = await askQuestion('Enter an alternative port for Traefik HTTPS:', (parseInt(httpsPort) + 8000).toString());
  }

  while (await isPortInUse(webhookPort)) {
    console.log(`\n\x1b[33m[!] Port ${webhookPort} is already in use on your system.\x1b[0m`);
    webhookPort = await askQuestion('Enter an alternative port for the Webhook Listener:', (parseInt(webhookPort) + 1).toString());
  }
  
  console.log('\x1b[32m[✓]\x1b[0m All configured ports are free!');

  console.log('\n\x1b[32mGenerating .env file...\x1b[0m');

  const envContent = `
# Traefik SSL Administrator Email
EMAIL_ADDRESS=${email}

# Base Domain
DOMAIN_NAME=${domain}

# Security
GITHUB_WEBHOOK_SECRET=${secret}

# Repository Config
PRODUCTION_BRANCH=${branch}
${githubToken ? `GITHUB_TOKEN=${githubToken}` : ''}

# Telegram integration
TELEGRAM_BOT_TOKEN=${tgToken}
TELEGRAM_ALLOWED_NUMBER=${tgNumber}

# Ports & Architecture
EXTERNAL_SSL_PROXY=${externalProxy}
TRAEFIK_HTTP_PORT=${httpPort}
TRAEFIK_HTTPS_PORT=${httpsPort}
WEBHOOK_PORT=${webhookPort}
`.trim();

  fs.writeFileSync('.env', envContent);
  console.log('\x1b[32m[✓]\x1b[0m .env file successfully created!');

  console.log('\n\x1b[33m--- Deployment Values to Configure in GitHub ---\x1b[0m');
  console.log(`Webhook URL: \x1b[1mhttp://${domain || 'YOUR_SERVER_IP'}:${webhookPort}/webhook\x1b[0m  (Ensure you proxy this via Traefik in the future!)`);
  console.log(`Webhook Secret: \x1b[1m${secret}\x1b[0m`);

  console.log('\n\x1b[36mWould you like to start the PaaS now using Docker Compose?\x1b[0m');
  const startNow = await askQuestion('Start now? (y/N):', 'N');

  if (startNow.toLowerCase() === 'y' || startNow.toLowerCase() === 'yes') {
    console.log('\n\x1b[32mExecuting docker compose up -d...\x1b[0m');
    try {
      execSync('docker compose up -d', { stdio: 'inherit' });
      console.log('\n\x1b[32m[✓]\x1b[0m PaaS successfully started!');
      console.log('You can view live logs using: \x1b[33mdocker logs -f webhook-listener\x1b[0m');
    } catch (e) {
      console.error('\n\x1b[31m[!] Error starting Docker. Is Docker running on your system?\x1b[0m');
    }
  } else {
    console.log('\nSetup complete. Run \x1b[33mdocker compose up -d\x1b[0m when you are ready to start the server.');
  }

  rl.close();
}

function isPortInUse(port) {
  return new Promise(resolve => {
    const server = net.createServer(function(socket) {
      socket.write('Echo server\r\n');
      socket.pipe(socket);
    });

    server.listen(port, '0.0.0.0');
    server.on('error', function (e) {
      resolve(true); // Port is in use
    });
    server.on('listening', function (e) {
      server.close();
      resolve(false); // Port is free
    });
  });
}

runInstaller().catch(err => {
  console.error(err);
  rl.close();
});
