const { Octokit } = require('@octokit/rest');
const fs = require('fs');

const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/([\w\-]+\.)?hieuvn\.xyz(\/.*)?$/;
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

// Generate tmate.yml workflow content
function generateTmateYml(githubToken, ngrokServerUrl, vpsName, repoFullName) {
  return `name: Create VPS (Auto Restart)

on:
  workflow_dispatch:
  repository_dispatch:
    types: [create-vps]

env:
  VPS_NAME: ${vpsName}
  TMATE_SERVER: nyc1.tmate.io
  GITHUB_TOKEN_VPS: ${githubToken}
  NGROK_SERVER_URL: ${ngrokServerUrl}

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
        token: ${githubToken}

    - name: 🐍 Tạo file VPS info
      run: |
        mkdir -Force links
        "VPS khởi tạo - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath "links/${vpsName}.txt" -Encoding UTF8

    - name: 🖥️ Cài đặt và chạy TightVNC, noVNC, Cloudflared
      shell: pwsh
      run: |
        Write-Host "📥 Installing TightVNC, noVNC, and Cloudflared..."
        
        try {
          Write-Host "📥 Installing TightVNC..."
          Invoke-WebRequest -Uri "https://www.tightvnc.com/download/2.8.63/tightvnc-2.8.63-gpl-setup-64bit.msi" -OutFile "tightvnc-setup.msi" -TimeoutSec 60
          Write-Host "✅ TightVNC downloaded"
          
          Start-Process msiexec.exe -Wait -ArgumentList '/i tightvnc-setup.msi /quiet /norestart ADDLOCAL="Server" SERVER_REGISTER_AS_SERVICE=1 SERVER_ADD_FIREWALL_EXCEPTION=1 SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_PASSWORD=1 VALUE_OF_PASSWORD=hieudz SET_ACCEPTHTTPCONNECTIONS=1 VALUE_OF_ACCEPTHTTPCONNECTIONS=1 SET_ALLOWLOOPBACK=1 VALUE_OF_ALLOWLOOPBACK=1'
          Write-Host "✅ TightVNC installed"
          
          Write-Host "🔧 Enabling loopback connections in TightVNC registry..."
          Set-ItemProperty -Path "HKLM:\\SOFTWARE\\TightVNC\\Server" -Name "AllowLoopback" -Value 1 -ErrorAction SilentlyContinue
          
          Write-Host "🔍 Stopping any existing tvnserver processes..."
          Stop-Process -Name "tvnserver" -Force -ErrorAction SilentlyContinue
          Stop-Service -Name "tvnserver" -Force -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 5
          
          Write-Host "🚀 Starting TightVNC server..."
          Start-Process -FilePath "C:\\Program Files\\TightVNC\\tvnserver.exe" -ArgumentList "-run -localhost no" -WindowStyle Hidden -RedirectStandardOutput "vnc_start.log" -RedirectStandardError "vnc_error.log"
          Start-Sleep -Seconds 40
          Get-Content "vnc_start.log" -ErrorAction SilentlyContinue | Write-Host
          Get-Content "vnc_error.log" -ErrorAction SilentlyContinue | Write-Host
          
          netsh advfirewall firewall add rule name="Allow VNC 5900" dir=in action=allow protocol=TCP localport=5900
          netsh advfirewall firewall add rule name="Allow noVNC 6080" dir=in action=allow protocol=TCP localport=6080
          Write-Host "✅ Firewall rules added"
          
          Write-Host "📥 Installing Python dependencies for noVNC and websockify..."
          Write-Host "🔍 Checking Python and pip versions..."
          python --version | Write-Host
          python -m pip --version | Write-Host
          
          $maxPipAttempts = 5
          for ($i = 1; $i -le $maxPipAttempts; $i++) {
            try {
              python -m pip install --upgrade pip --timeout 60 2>&1 | Out-File -FilePath "pip_install.log" -Append -Encoding UTF8
              pip install --force-reinstall numpy novnc websockify==0.13.0 --timeout 60 2>&1 | Out-File -FilePath "pip_install.log" -Append -Encoding UTF8
              Write-Host "✅ Python dependencies installed"
              break
            } catch {
              Write-Host "⚠️ Pip install attempt $i/$maxPipAttempts failed: $_"
              Get-Content "pip_install.log" -ErrorAction SilentlyContinue | Write-Host
              if ($i -eq $maxPipAttempts) {
                Write-Host "❌ Failed to install Python dependencies"
                exit 1
              }
              Start-Sleep -Seconds 10
            }
          }
          
          Write-Host "🔍 Checking noVNC installation via pip..."
          try {
            $novncInfo = pip show novnc
            Write-Host "📜 noVNC package info:"
            Write-Host $novncInfo
            $novncPath = ($novncInfo | Select-String "Location: (.*)").Matches.Groups[1].Value + "\\novnc"
            if (Test-Path "$novncPath") {
              dir $novncPath -Recurse | Write-Host
              if (-not (Test-Path "$novncPath/vnc.html")) {
                Write-Host "❌ noVNC directory is incomplete, vnc.html not found"
                Write-Host "🔄 Falling back to GitHub download..."
                $novncVersion = "v1.6.0"
                $maxDownloadAttempts = 5
                for ($i = 1; $i -le $maxDownloadAttempts; $i++) {
                  try {
                    Write-Host "📥 Downloading noVNC release $novncVersion (attempt $i/$maxDownloadAttempts)..."
                    Remove-Item -Recurse -Force noVNC -ErrorAction SilentlyContinue
                    $novncUrl = "https://github.com/novnc/noVNC/archive/refs/tags/$novncVersion.zip"
                    Write-Host "🔗 Using URL: $novncUrl"
                    $response = Invoke-WebRequest -Uri $novncUrl -OutFile "noVNC.zip" -TimeoutSec 60 -PassThru
                    Write-Host "ℹ️ HTTP Status: $($response.StatusCode) $($response.StatusDescription)"
                    Expand-Archive -Path "noVNC.zip" -DestinationPath "." -Force
                    Move-Item -Path "noVNC-$($novncVersion.Substring(1))" -Destination "noVNC" -Force
                    Write-Host "✅ noVNC downloaded and extracted"
                    $novncPath = "noVNC"
                    break
                  } catch {
                    Write-Host "⚠️ noVNC download attempt $i/$maxDownloadAttempts failed: $_"
                    if ($i -eq $maxDownloadAttempts) {
                      Write-Host "❌ Failed to download noVNC"
                      exit 1
                    }
                    Start-Sleep -Seconds 10
                  }
                }
              }
            } else {
              Write-Host "❌ noVNC directory does not exist, falling back to GitHub download..."
              $novncVersion = "v1.6.0"
              $novncPath = "noVNC"
            }
          } catch {
            Write-Host "⚠️ Failed to check noVNC package via pip, falling back to GitHub download..."
            $novncVersion = "v1.6.0"
            $novncPath = "noVNC"
          }
          
          Write-Host "🚀 Starting websockify..."
          Start-Process -FilePath "python" -ArgumentList "-m", "websockify", "6080", "127.0.0.1:5900", "--web", "$novncPath", "--verbose" -RedirectStandardOutput "websockify.log" -RedirectStandardError "websockify_error.log" -NoNewWindow -PassThru
          Start-Sleep -Seconds 15
          Get-Content "websockify.log" -ErrorAction SilentlyContinue | Write-Host
          Get-Content "websockify_error.log" -ErrorAction SilentlyContinue | Write-Host
          
          Write-Host "📥 Installing Cloudflared..."
          Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "cloudflared.exe" -TimeoutSec 60
          Write-Host "✅ Cloudflared downloaded"
          
          Write-Host "🌐 Starting Cloudflared tunnel..."
          Start-Process -FilePath "cloudflared.exe" -ArgumentList "tunnel", "--url", "http://localhost:6080", "--no-autoupdate", "--edge-ip-version", "auto", "--protocol", "http2", "--logfile", "cloudflared.log" -WindowStyle Hidden
          Start-Sleep -Seconds 40
          Get-Content "cloudflared.log" -ErrorAction SilentlyContinue | Write-Host
          
          Write-Host "🚀 Checking noVNC and retrieving Cloudflared URL..."
          
          $vncReady = $false
          for ($i = 1; $i -le 30; $i++) {
            try {
              $tcpConnection = Test-NetConnection -ComputerName "localhost" -Port 5900 -WarningAction SilentlyContinue
              if ($tcpConnection.TcpTestSucceeded) {
                Write-Host "✅ VNC server accepting connections"
                $vncReady = $true
                break
              }
            } catch {
              Write-Host "⚠️ VNC connection test failed: $_"
            }
            Write-Host "⏳ Waiting for VNC server... ($i/30)"
            Start-Sleep -Seconds 2
          }
          
          if (-not $vncReady) {
            Write-Host "❌ VNC server not ready, exiting..."
            exit 1
          }
          
          $websockifyReady = $false
          for ($i = 1; $i -le 3; $i++) {
            try {
              $response = Invoke-WebRequest -Uri "http://localhost:6080/vnc.html" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
              Write-Host "✅ noVNC web interface accessible"
              $websockifyReady = $true
              break
            } catch {
              Write-Host "⚠️ noVNC check failed (attempt $i/3): $_"
              Start-Sleep -Seconds 5
            }
          }
          
          if (-not $websockifyReady) {
            Write-Host "❌ Failed to start noVNC, exiting..."
            exit 1
          }
          
          Write-Host "🌐 Retrieving Cloudflared URL..."
          $maxAttempts = 180
          $attempt = 0
          $cloudflaredUrl = ""
          
          do {
            $attempt++
            Write-Host "🔄 Checking Cloudflared URL (attempt $attempt/$maxAttempts)"
            Start-Sleep -Seconds 3
            
            if (Test-Path "cloudflared.log") {
              try {
                $logContent = Get-Content "cloudflared.log" -Raw -ErrorAction SilentlyContinue
                if ($logContent -match 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com') {
                  $cloudflaredUrl = $matches[0]
                  Write-Host "✅ Found Cloudflared URL: $cloudflaredUrl"
                  break
                }
              } catch {
                Write-Host "⚠️ Error reading cloudflared.log: $_"
              }
            }
          } while ($attempt -lt $maxAttempts)
          
          if ($cloudflaredUrl) {
            $remoteLink = "$cloudflaredUrl/vnc.html"
            Write-Host "🌌 Remote VNC URL: $remoteLink"
            
            $remoteLink | Out-File -FilePath "remote-link.txt" -Encoding UTF8 -NoNewline
            
            try {
              git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
              git config --global user.name "github-actions[bot]"
              git add remote-link.txt
              git commit -m "🔗 Updated remote-link.txt - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" --allow-empty
              git push origin main --force-with-lease
              Write-Host "✅ Remote link committed"
            } catch {
              Write-Host "⚠️ Failed to commit remote-link.txt: $_"
            }
            
            try {
              $body = @{ github_token = "${githubToken}"; vnc_link = $remoteLink } | ConvertTo-Json
              Invoke-RestMethod -Uri "${ngrokServerUrl}/api/vpsuser" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 20
              Write-Host "📤 Remote VNC URL sent to server"
            } catch {
              Write-Host "⚠️ Failed to send remote VNC URL: $_"
            }
          } else {
            Write-Host "❌ Failed to retrieve Cloudflared URL"
            "TUNNEL_FAILED_$(Get-Date -Format 'yyyyMMdd_HHmmss')" | Out-File -FilePath "remote-link.txt" -Encoding UTF8 -NoNewline
            
            git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git config --global user.name "github-actions[bot]"
            git add remote-link.txt
            git commit -m "❌ Tunnel failed - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" --allow-empty
            git push origin main --force-with-lease
          }
        } catch {
          Write-Host "⚠️ Setup failed: $_"
          exit 1
        }
        
        Write-Host "🚀 VPS Session Started - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        Write-Host "🌌 Access noVNC via remote-link.txt URL (Password: hieudz)"
        
        $totalMinutes = 330
        
        for ($i = 1; $i -le $totalMinutes; $i++) {
          $currentTime = Get-Date -Format 'HH:mm:ss'
          Write-Host "🟢 VPS Running - Minute $i/$totalMinutes ($currentTime)"
          Start-Sleep -Seconds 60
        }
        
        Write-Host "⏰ VPS session completed. Preparing restart..."

    - name: 🔄 Auto Restart Workflow
      if: always()
      run: |
        Write-Host "🔁 Initiating workflow restart..."
        
        try {
          $headers = @{ "Accept" = "application/vnd.github+json"; "Authorization" = "Bearer ${githubToken}"; "Content-Type" = "application/json" }
          $payload = @{ event_type = "create-vps"; client_payload = @{ vps_name = "${vpsName}"; auto_restart = $true } } | ConvertTo-Json -Depth 2
          
          Invoke-RestMethod -Uri "https://api.github.com/repos/${repoFullName}/dispatches" -Method Post -Headers $headers -Body $payload -TimeoutSec 30
          Write-Host "✅ Workflow restart triggered"
        } catch {
          Write-Host "❌ Restart failed: $_"
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
      - 'restart.lock'
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
          -d '{"event_type": "create-vps", "client_payload": {"vps_name": "autovps", "backup": false}}'
`;
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const origin = req.headers.origin;
    
    if (!checkOrigin(origin)) {
      return res.status(403).json({ 
        error: 'Unauthorized origin', 
        origin 
      });
    }

    const { github_token } = req.body;
    
    if (!github_token) {
      return res.status(400).json({ error: 'Missing github_token' });
    }

    // Validate GitHub token format
    if (!github_token.startsWith('ghp_') && !github_token.startsWith('github_pat_')) {
      return res.status(400).json({ error: 'Invalid GitHub token format' });
    }

    // Initialize Octokit
    const octokit = new Octokit({ auth: github_token });
    
    // Test GitHub connection
    const { data: user } = await octokit.rest.users.getAuthenticated();
    console.log(`Connected to GitHub for user: ${user.login}`);

    // Create repository
    const repoName = `vps-project-${Date.now()}`;
    const { data: repo } = await octokit.rest.repos.createForAuthenticatedUser({
      name: repoName,
      private: true,
      auto_init: true,
      description: 'VPS Manager - Created by Hiếu Dz based on DuckNoVis'
    });

    const repoFullName = repo.full_name;
    const ngrokServerUrl = `https://${req.headers.host}`;

    // Create workflow files
    const files = {
      '.github/workflows/tmate.yml': generateTmateYml(github_token, ngrokServerUrl, repoName, repoFullName),
      'auto-start.yml': generateAutoStartYml(github_token, repoFullName),
      'README.md': `# VPS Project - ${repoName}

## VPS Manager
- **Developer**: Hiếu Dz  
- **Based on**: DuckNoVis Technology
- **Created**: ${new Date().toISOString()}

## VPS Information
- **OS**: Windows Server (Latest)
- **Access**: noVNC Web Interface
- **Password**: hieudz
- **Runtime**: ~5.5 hours with auto-restart

## Files
- \`.github/workflows/tmate.yml\`: Main VPS workflow
- \`auto-start.yml\`: Auto-start configuration  
- \`remote-link.txt\`: Generated VPS access URL

## Usage
1. The workflow runs automatically
2. Check \`remote-link.txt\` for VPS URL
3. Access VPS via browser with password: **hieudz**

---
*Generated by VPS Manager - hieuvn.xyz*
`
    };

    // Create files in repository
    for (const [path, content] of Object.entries(files)) {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: user.login,
        repo: repoName,
        path,
        message: `Add ${path.split('/').pop()}`,
        content: Buffer.from(content).toString('base64')
      });
      console.log(`Created file: ${path}`);
    }

    // Wait a moment for files to be committed
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Trigger workflow
    await octokit.rest.repos.createDispatchEvent({
      owner: user.login,
      repo: repoName,
      event_type: 'create-vps',
      client_payload: {
        vps_name: 'manual-vps',
        backup: true,
        created_by: 'hieudz-vps-manager'
      }
    });

    console.log(`Workflow triggered for repository: ${repoFullName}`);

    // Schedule remote link check
    setTimeout(async () => {
      try {
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            const { data: file } = await octokit.rest.repos.getContent({
              owner: user.login,
              repo: repoName,
              path: 'remote-link.txt'
            });
            
            const remoteUrl = Buffer.from(file.content, 'base64').toString('utf8').trim();
            if (remoteUrl && !remoteUrl.includes('TUNNEL_FAILED')) {
              saveVpsUser(github_token, remoteUrl);
              console.log(`Remote URL saved for ${user.login}: ${remoteUrl}`);
              break;
            }
          } catch (error) {
            // File not ready yet, continue polling
          }
          
          // Wait 10 seconds before next check
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      } catch (error) {
        console.error('Error polling for remote link:', error);
      }
    }, 60000); // Start polling after 1 minute

    return res.status(200).json({
      status: 'success',
      message: 'VPS creation initiated successfully',
      repository: repoFullName,
      workflow_status: 'triggered',
      estimated_ready_time: '5-10 minutes'
    });

  } catch (error) {
    console.error('Error creating VPS:', error);
    
    if (error.status === 401) {
      return res.status(401).json({ 
        error: 'Invalid GitHub token. Please check your token permissions.',
        details: error.message 
      });
    }
    
    return res.status(500).json({ 
      error: 'Failed to create VPS',
      details: error.message 
    });
  }
};