const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const sodium = require('libsodium-wrappers');

const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/([\w\-]+\.)?(hieuvn\.xyz|vps-github\.vercel\.app)(\/.*)?$/;
const VPS_USER_FILE = '/tmp/vpsuser.json';

// Save VPS user to temporary storage
function saveVpsUser(githubToken, remoteLink) {
  try {
    let users = {};
    if (fs.existsSync(VPS_USER_FILE)) {
      const data = fs.readFileSync(VPS_USER_FILE, 'utf8');
      users = JSON.parse(data);
    }
    users[githubToken] = remoteLink;
    fs.writeFileSync(VPS_USER_FILE, JSON.stringify(users, null, 2));
    console.log(`VPS user saved: ${githubToken.substring(0, 10)}...***`);
  } catch (error) {
    console.error('Error saving VPS user:', error);
  }
}

// Check if origin is allowed
function checkOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERN.test(origin) || origin.includes('localhost') || origin.includes('127.0.0.1');
}

// ** An toàn: Workflow sẽ đọc token từ Secret, không ghi trực tiếp **
// ** Đầy đủ: Toàn bộ script PowerShell được giữ nguyên 100% **
function generateTmateYml(vpsName, repoFullName) {
  return `name: Create VPS (Auto Restart)

on:
  workflow_dispatch:
  repository_dispatch:
    types: [create-vps]

env:
  VPS_NAME: ${vpsName}
  # An toàn: Đọc token từ GitHub Secrets
  GITHUB_TOKEN_VPS: \${{ secrets.GITHUB_TOKEN_VPS }}

jobs:
  deploy:
    runs-on: windows-latest
    permissions:
      contents: write
      actions: write

    steps:
    - name: ⬇️ Checkout source
      uses: actions/checkout@v4

    - name: 📝 Tạo file VPS info
      run: |
        mkdir -Force links
        "VPS khởi tạo - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath "links/${vpsName}.txt" -Encoding UTF8

    - name: 🖥️ Cài đặt và chạy VNC & Tunnel
      shell: pwsh
      run: |
        $ErrorActionPreference = "Stop"
        try {
          Write-Host "🔥 Installing TightVNC..."
          Invoke-WebRequest -Uri "https://www.tightvnc.com/download/2.8.8/tightvnc-2.8.8-gpl-setup-64bit.msi" -OutFile "tightvnc-setup.msi" -TimeoutSec 120 -UseBasicParsing
          Start-Process msiexec.exe -Wait -ArgumentList '/i tightvnc-setup.msi /quiet /norestart ADDLOCAL="Server" SERVER_REGISTER_AS_SERVICE=1 SERVER_ADD_FIREWALL_EXCEPTION=1 SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_PASSWORD=1 VALUE_OF_PASSWORD=hieudz SET_ACCEPTHTTPCONNECTIONS=1 VALUE_OF_ACCEPTHTTPCONNECTIONS=1 SET_ALLOWLOOPBACK=1 VALUE_OF_ALLOWLOOPBACK=1'
          Write-Host "✅ TightVNC installed"
          Stop-Process -Name "tvnserver" -Force -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 5
          Write-Host "🚀 Starting TightVNC server..."
          Start-Process -FilePath "C:\\Program Files\\TightVNC\\tvnserver.exe" -ArgumentList "-run"
          Start-Sleep -Seconds 40
          Write-Host "🔥 Installing Python dependencies..."
          pip install --upgrade pip --timeout 120
          pip install numpy novnc websockify==0.13.0 --timeout 120
          Write-Host "🔥 Downloading noVNC..."
          Invoke-WebRequest -Uri "https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.zip" -OutFile novnc.zip -TimeoutSec 120
          Expand-Archive -Path novnc.zip -DestinationPath . -Force
          Rename-Item -Path "noVNC-1.4.0" -NewName "noVNC" -Force
          Write-Host "🔥 Installing Cloudflared..."
          Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "cloudflared.exe" -TimeoutSec 120
          Write-Host "🚀 Starting websockify..."
          Start-Process -FilePath "python" -ArgumentList "-m", "websockify", "6080", "127.0.0.1:5900", "--web", "noVNC" -WindowStyle Hidden
          Start-Sleep -Seconds 15
          Write-Host "🌍 Starting Cloudflared tunnel..."
          Start-Process -FilePath ".\\cloudflared.exe" -ArgumentList "tunnel", "--url", "http://localhost:6080" -RedirectStandardError "cloudflared.log" -RedirectStandardOutput "cloudflared.log" -WindowStyle Hidden
          Start-Sleep -Seconds 40
          Write-Host "🔗 Retrieving Cloudflared URL..."
          $cloudflaredUrl = (Get-Content "cloudflared.log" -Raw | Select-String -Pattern 'https://[a-zA-Z0-9-]+.trycloudflare.com' -AllMatches).Matches.Value | Select-Object -First 1
          if ($cloudflaredUrl) {
            $remoteLink = "$cloudflaredUrl/vnc.html"
            Write-Host "🌌 Remote VNC URL: $remoteLink"
            Set-Content -Path "remote-link.txt" -Value $remoteLink
            git config --global user.email "action@github.com"
            git config --global user.name "GitHub Action"
            git add remote-link.txt
            git commit -m "🔗 Add remote VNC link"
            git push
          } else {
            Write-Host "❌ Failed to retrieve Cloudflared URL."
            exit 1
          }
        } catch {
          Write-Host "❌ An error occurred: $_"
            # Trigger restart on failure
            Invoke-RestMethod -Uri "https://api.github.com/repos/${repoFullName}/dispatches" -Method POST -Headers @{"Authorization"="token \${{ env.GITHUB_TOKEN_VPS }}";"Accept"="application/vnd.github.v3+json"} -Body '{"event_type": "create-vps"}'
          exit 1
        }
`;
}

function generateAutoStartYml(repoFullName) {
  return `name: Auto Start VPS on Push
on:
  push:
    branches: [main]
jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: 🚀 Trigger tmate.yml
        uses: peter-evans/repository-dispatch@v3
        with:
          token: \${{ secrets.GITHUB_TOKEN_VPS }}
          repository: ${repoFullName}
          event-type: create-vps
`;
}

async function createOrUpdateFile(octokit, owner, repo, path, content, message) {
  try {
    let sha;
    try {
      const { data: existingFile } = await octokit.rest.repos.getContent({ owner, repo, path });
      sha = existingFile.sha;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: Buffer.from(content).toString('base64'),
      sha,
    });
    console.log(`✅ Successfully created/updated file: ${path}`);
  } catch (error) {
    console.error(`❌ Error processing file ${path}:`, error.message);
    throw error;
  }
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const origin = req.headers.origin;
    if (!checkOrigin(origin)) {
      return res.status(403).json({ error: 'Unauthorized origin' });
    }

    const { github_token } = req.body;
    if (!github_token) {
      return res.status(400).json({ error: 'Missing github_token' });
    }

    const octokit = new Octokit({ auth: github_token });
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const repoName = `vps-project-${Date.now()}`;

    const { data: repo } = await octokit.rest.repos.createForAuthenticatedUser({
      name: repoName,
      private: false,
      auto_init: true,
    });
    const repoFullName = repo.full_name;

    // ** TẠO SECRET AN TOÀN **
    await sodium.ready;
    const { data: publicKey } = await octokit.rest.actions.getRepoPublicKey({
      owner: user.login,
      repo: repoName,
    });
    const secretBytes = Buffer.from(github_token);
    const keyBytes = Buffer.from(publicKey.key, 'base64');
    const encryptedBytes = sodium.crypto_box_seal(secretBytes, keyBytes);
    const encryptedSecret = Buffer.from(encryptedBytes).toString('base64');
    await octokit.rest.actions.createOrUpdateRepoSecret({
      owner: user.login,
      repo: repoName,
      secret_name: 'GITHUB_TOKEN_VPS',
      encrypted_value: encryptedSecret,
      key_id: publicKey.key_id,
    });
    console.log(`✅ Successfully created repository secret for ${repoFullName}`);
    
    console.log(`Waiting for repository initialization for ${repoFullName}...`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const files = {
      '.github/workflows/tmate.yml': {
        content: generateTmateYml(repoName, repoFullName),
        message: 'feat: Add VPS creation workflow'
      },
      '.github/workflows/auto-start.yml': {
        content: generateAutoStartYml(repoFullName),
        message: 'feat: Add auto-start workflow'
      },
      'README.md': {
        content: `# VPS Project\n- **Password**: hieudz\n- **Link**: Check file \`remote-link.txt\``,
        message: 'docs: Add initial README'
      }
    };
    
    for (const [path, { content, message }] of Object.entries(files)) {
      await createOrUpdateFile(octokit, user.login, repoName, path, content, message);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`Triggering the main workflow for ${repoFullName}...`);
    await octokit.rest.repos.createDispatchEvent({
      owner: user.login,
      repo: repoName,
      event_type: 'create-vps',
    });

    res.status(200).json({
      status: 'success',
      message: 'Secure and stable VPS repository created.',
      repository_url: `https://github.com/${repoFullName}`
    });

  } catch (error) {
    console.error('FATAL ERROR:', error);
    const status = error.status || 500;
    const message = status === 401
      ? 'Invalid GitHub token. Check permissions (repo, workflow).'
      : 'Failed to create VPS';
    res.status(status).json({ error: message, details: error.message });
  }
};
