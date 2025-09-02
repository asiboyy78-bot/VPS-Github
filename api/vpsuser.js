const fs = require('fs');
const path = require('path');

const VPS_USER_FILE = '/tmp/vpsuser.json';

// Load VPS users from temporary storage
function loadVpsUsers() {
  try {
    if (fs.existsSync(VPS_USER_FILE)) {
      const data = fs.readFileSync(VPS_USER_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading VPS users:', error);
  }
  return {};
}

// Save VPS user to temporary storage
function saveVpsUser(githubToken, remoteLink) {
  try {
    const users = loadVpsUsers();
    users[githubToken] = remoteLink;
    fs.writeFileSync(VPS_USER_FILE, JSON.stringify(users, null, 2));
    console.log(`VPS user saved: ${githubToken.substring(0, 10)}...***`);
  } catch (error) {
    console.error('Error saving VPS user:', error);
  }
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      const users = loadVpsUsers();
      const usersList = Object.entries(users).map(([token, link]) => ({
        token: token.substring(0, 10) + '***',
        link
      }));
      
      return res.status(200).json({
        status: 'success',
        total: usersList.length,
        users: usersList
      });
    }

    if (req.method === 'POST') {
      const { github_token, vnc_link } = req.body;
      
      if (!github_token) {
        return res.status(400).json({ error: 'Missing github_token' });
      }

      if (vnc_link) {
        // Save VPS user
        saveVpsUser(github_token, vnc_link);
        return res.status(200).json({
          status: 'success',
          message: 'VPS user saved successfully',
          github_token: github_token.substring(0, 10) + '***',
          remote_link: vnc_link
        });
      } else {
        // Get VPS user
        const users = loadVpsUsers();
        if (users[github_token]) {
          return res.status(200).json({
            status: 'success',
            remote_link: users[github_token],
            github_token: github_token.substring(0, 10) + '***'
          });
        } else {
          return res.status(404).json({ error: 'VPS user not found' });
        }
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('VPS User API Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
};