const { Octokit } = require('@octokit/rest');
const fs = require('fs');

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

// Generate tmate.yml workflow content with stability improvements
function generateTmateYml(githubToken, vpsName, repoFullName) {
  return `name: Create VPS (Auto Restart)

on:
  workflow_dispatch:
  repository_dispatch:
    types: [create-vps]

env:
  VPS_NAME: ${vpsName}
  GITHUB_TOKEN_VPS: ${githubToken}

jobs:
  deploy:
    runs-on: windows-latest
    permissions:
      contents: write
      actions: write

    steps:
    - name: ⬇️ Checkout source
      uses: actions/checkout@v4
      with:
        token: \${{ secrets.GITHUB_TOKEN }}

    - name: 📝 Tạo file VPS info
      run: |
        mkdir -Force links
        "VPS khởi tạo - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath "links/${vpsName}.txt" -Encoding UTF8

    - name: 🖥️ Cài đặt và chạy VNC & Tunnel
      shell: pwsh
      run: |
        # Cài đặt chế độ lỗi nghiêm ngặt để script dừng lại ngay khi có lỗi
        $ErrorActionPreference = "Stop"

        try {
          Write-Host "🔥 Installing TightVNC..."
          Invoke-WebRequest -Uri "https://www.tightvnc.com/download/2.8.8/tightvnc-2.8.8-gpl-setup-64bit.msi" -OutFile "tightvnc-setup.msi" -TimeoutSec 120 -UseBasicParsing
          Write-Host "✅ TightVNC downloaded"
          
          Start-Process msiexec.exe -Wait -ArgumentList '/i tightvnc-setup.msi /quiet /norestart ADDLOCAL="Server" SERVER_REGISTER_AS_SERVICE=1 SERVER_ADD_FIREWALL_EXCEPTION=1 SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_PASSWORD=1 VALUE_OF_PASSWORD=hieudz SET_ACCEPTHTTPCONNECTIONS=1 VALUE_OF_ACCEPTHTTPCONNECTIONS=1 SET_ALLOWLOOPBACK=1 VALUE_OF_ALLOWLOOPBACK=1'
          Write-Host "✅ TightVNC installed"
          
          # Đảm bảo dịch vụ đã dừng hẳn trước khi khởi động lại
          Write-Host "🔄 Stopping any existing tvnserver processes..."
          Stop-Process -Name "tvnserver" -Force -ErrorAction SilentlyContinue
          Stop-Service -Name "tvnserver" -Force -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 10
          
          Write-Host "🚀 Starting TightVNC server..."
          Start-Process -FilePath "C:\\Program Files\\TightVNC\\tvnserver.exe" -ArgumentList "-run"
          # Tăng thời gian chờ để VNC Server có đủ thời gian khởi động hoàn toàn
          Write-Host "⏳ Waiting for VNC server to initialize (60s)..."
          Start-Sleep -Seconds 60

          Write-Host "🔥 Installing Python dependencies for noVNC and websockify..."
          $maxPipAttempts = 3
          for ($i = 1; $i -le $maxPipAttempts; $i++) {
            try {
              Write-Host "Attempting pip install: $i/$maxPipAttempts"
              # Tăng timeout để tránh lỗi mạng
              pip install --upgrade pip --timeout 120
              pip install numpy novnc websockify==0.13.0 --timeout 120
              Write-Host "✅ Python dependencies installed successfully."
              break
            } catch {
              Write-Host "⚠️ Pip install attempt $i failed: $_"
              if ($i -eq $maxPipAttempts) {
                throw "Failed to install Python dependencies after $maxPipAttempts attempts."
              }
              Start-Sleep -Seconds 15
            }
          }
          
          Write-Host "🔥 Downloading noVNC as a fallback..."
          try {
            Invoke-WebRequest -Uri "https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.zip" -OutFile novnc.zip -TimeoutSec 120 -UseBasicParsing
            Expand-Archive -Path novnc.zip -DestinationPath . -Force
            Rename-Item -Path "noVNC-1.4.0" -NewName "noVNC" -Force
            Write-Host "✅ noVNC downloaded and extracted."
          } catch {
            throw "Failed to download and set up noVNC."
          }

          Write-Host "🔥 Installing Cloudflared..."
          Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "cloudflared.exe" -TimeoutSec 120 -UseBasicParsing
          Write-Host "✅ Cloudflared downloaded"
          
          Write-Host "🚀 Starting websockify..."
          Start-Process -FilePath "python" -ArgumentList "-m", "websockify", "6080", "127.0.0.1:5900", "--web", "noVNC" -WindowStyle Hidden
          Start-Sleep -Seconds 15
          
          Write-Host "🌍 Starting Cloudflared tunnel..."
          # Chuyển log ra file để kiểm tra
          Start-Process -FilePath ".\\cloudflared.exe" -ArgumentList "tunnel", "--url", "http://localhost:6080", "--no-autoupdate" -RedirectStandardError "cloudflared.log" -RedirectStandardOutput "cloudflared.log" -WindowStyle Hidden
          
          # Tăng thời gian chờ để Cloudflared kết nối
          Write-Host "⏳ Waiting for Cloudflare tunnel to establish (60s)..."
          Start-Sleep -Seconds 60
          
          Write-Host "🔗 Retrieving Cloudflared URL..."
          $maxAttempts = 10
          $attempt = 0
          $cloudflaredUrl = ""
          
          while ($attempt -lt $maxAttempts -and -not $cloudflaredUrl) {
            $attempt++
            Write-Host "Checking Cloudflared log (Attempt $attempt/$maxAttempts)..."
            $logContent = Get-Content "cloudflared.log" -Raw -ErrorAction SilentlyContinue
            
            # Kiểm tra lỗi trước
            if ($logContent -match 'ERR|fail|error') {
              Write-Host "❌ Detected error in Cloudflared log:"
              Write-Host $logContent
              throw "Cloudflared tunnel failed to start."
            }
            
            # Tìm URL
            if ($logContent -match '(https://[a-zA-Z0-9-]+.trycloudflare.com)') {
              $cloudflaredUrl = $matches[0]
              Write-Host "✅ Found Cloudflared URL: $cloudflaredUrl"
            } else {
              Start-Sleep -Seconds 10
            }
          }
          
          if ($cloudflaredUrl) {
            $remoteLink = "$cloudflaredUrl/vnc.html"
            Write-Host "🌌 Remote VNC URL: $remoteLink"
            
            # Lưu link vào file để commit
            Set-Content -Path "remote-link.txt" -Value $remoteLink
            
            # Commit và push link lên repo
            git config --global user.email "action@github.com"
            git config --global user.name "GitHub Action"
            git add remote-link.txt
            git commit -m "🔗 Add remote VNC link"
            git push
            Write-Host "✅ Remote link committed and pushed."
          } else {
            Write-Host "❌ Failed to retrieve Cloudflared URL."
            # In log để debug
            Get-Content "cloudflared.log" -ErrorAction SilentlyContinue | Write-Host
            throw "Could not get Cloudflared URL after multiple attempts."
          }
        } catch {
            Write-Host "❌ An error occurred during setup: $_"
            # Trigger restart workflow khi có lỗi
            Write-Host "🔄 Triggering workflow restart due to failure..."
            try {
                $headers = @{
                    "Authorization" = "token \${{ env.GITHUB_TOKEN_VPS }}"
                    "Accept" = "application/vnd.github.v3+json"
                }
                $body = @{ event_type = "create-vps" } | ConvertTo-Json
                Invoke-RestMethod -Uri "https://api.github.com/repos/${repoFullName}/dispatches" -Method POST -Headers $headers -Body $body
                Write-Host "✅ Workflow restart triggered."
            } catch {
                Write-Host "❌ Failed to trigger workflow restart: $_"
                exit 1
            }
            exit 1
        }
`;
}

// Generate auto-start.yml content
function generateAutoStartYml(githubToken, repoFullName) {
  return `name: Auto Start VPS on Push

on:
  push:
    branches: [main]
    paths-ignore:
      - 'remote-link.txt'
      - 'README.md'
      - '.backup/**'
      - 'links/**'

jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: 🚀 Trigger tmate.yml
        run: |
          curl -X POST https://api.github.com/repos/${repoFullName}/dispatches \\
          -H "Accept: application/vnd.github.v3+json" \\
          -H "Authorization: token ${githubToken}" \\
          -d '{"event_type": "create-vps"}'
`;
}

// Helper function to create or update file safely
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
    console.log(`Successfully ${sha ? 'updated' : 'created'} file: ${path}`);
  } catch (error) {
    console.error(`Error processing file ${path}:`, error.message);
    throw error;
  }
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const origin = req.headers.origin;
    if (!checkOrigin(origin)) {
      return res.status(403).json({ error: 'Unauthorized origin', origin });
    }

    const { github_token } = req.body;
    if (!github_token) {
      return res.status(400).json({ error: 'Missing github_token' });
    }
    if (!github_token.startsWith('ghp_') && !github_token.startsWith('github_pat_')) {
      return res.status(400).json({ error: 'Invalid GitHub token format' });
    }

    const octokit = new Octokit({ auth: github_token });
    const { data: user } = await octokit.rest.users.getAuthenticated();
    console.log(`Authenticated as GitHub user: ${user.login}`);

    // Create a PUBLIC repository
    const repoName = `vps-project-${Date.now()}`;
    const { data: repo } = await octokit.rest.repos.createForAuthenticatedUser({
      name: repoName,
      private: false, // *** CHANGED TO PUBLIC ***
      auto_init: true,
      description: 'VPS Manager - Created by Hiếu Dz based on DuckNoVis'
    });
    const repoFullName = repo.full_name;

    console.log('Waiting for repository initialization...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const files = {
      '.github/workflows/tmate.yml': {
        content: generateTmateYml(github_token, repoName, repoFullName),
        message: 'feat: Add VPS creation workflow'
      },
      '.github/workflows/auto-start.yml': {
        content: generateAutoStartYml(github_token, repoFullName),
        message: 'feat: Add auto-start workflow'
      },
      'README.md': {
        content: `# VPS Project - ${repoName}
- **Password**: hieudz
- **Access Link**: Check the file \`remote-link.txt\` after the workflow runs.
---
*Generated by VPS Manager - hieuvn.xyz*`,
        message: 'docs: Add initial README'
      }
    };
    
    // Create files sequentially
    for (const [path, { content, message }] of Object.entries(files)) {
      await createOrUpdateFile(octokit, user.login, repoName, path, content, message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('Waiting for workflows to be registered...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Trigger the main workflow
    await octokit.rest.repos.createDispatchEvent({
      owner: user.login,
      repo: repoName,
      event_type: 'create-vps',
    });
    console.log(`Workflow triggered for repository: ${repoFullName}`);

    // Start polling for the remote link in the background
    setTimeout(async () => {
      console.log(`Starting to poll for remote-link.txt in ${repoFullName}...`);
      for (let i = 0; i < 40; i++) { // Poll for up to 10 minutes
        try {
          await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15s between checks
          const { data: file } = await octokit.rest.repos.getContent({
            owner: user.login,
            repo: repoName,
            path: 'remote-link.txt'
          });
          const remoteUrl = Buffer.from(file.content, 'base64').toString('utf8').trim();
          if (remoteUrl && remoteUrl.startsWith('http')) {
            saveVpsUser(github_token, remoteUrl);
            console.log(`✅ Remote URL found and saved: ${remoteUrl}`);
            return; // Stop polling
          }
        } catch (error) {
          // 404 means the file isn't created yet, which is normal.
          if (error.status !== 404) {
            console.error(`Polling error for ${repoFullName}:`, error.message);
          }
        }
      }
      console.log(`Polling timed out for ${repoFullName}.`);
    }, 90000); // Start polling after 90 seconds

    res.status(200).json({
      status: 'success',
      message: 'Public VPS repository created and workflow initiated.',
      repository_url: `https://github.com/${repoFullName}`
    });

  } catch (error) {
    console.error('FATAL ERROR:', error);
    const status = error.status || 500;
    const message = status === 401
      ? 'Invalid GitHub token. Check permissions (repo, workflow).'
      : 'Failed to create VPS repository.';
    res.status(status).json({ error: message, details: error.message });
  }
};
