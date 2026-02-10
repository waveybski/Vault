const localtunnel = require('localtunnel');
const https = require('https');

// Function to get Public IP (IPv4 ONLY)
// We use ipv4.icanhazip.com to ensure we get the IPv4 address LocalTunnel expects
function getPublicIP() {
    return new Promise((resolve, reject) => {
        https.get('https://ipv4.icanhazip.com', function(resp) {
            let data = '';
            resp.on('data', (chunk) => data += chunk);
            resp.on('end', () => resolve(data.trim()));
        }).on('error', function(e) {
            // Fallback
            resolve("Could not fetch IP. Please google 'what is my ip'");
        });
    });
}

(async () => {
  console.log('---------------------------------------------------');
  console.log('[...] Fetching your Public IP for verification...');
  const ip = await getPublicIP();
  
  console.log('[...] Starting Secure Tunnel...');
  const tunnel = await localtunnel({ port: 3000 });

  console.log('\n===================================================');
  console.log('   YOUR SECURE CHAT IS ONLINE');
  console.log('===================================================');
  console.log(`\nLINK:      ${tunnel.url}`);
  console.log(`\nPASSWORD:  ${ip}`);
  console.log('\n---------------------------------------------------');
  console.log('IMPORTANT INSTRUCTIONS:');
  console.log('1. Open the LINK on your phone.');
  console.log('2. You will see a "Click to Continue" page.');
  console.log('3. Copy/Paste the PASSWORD above into the box and click Submit.');
  console.log('===================================================');

  tunnel.on('close', () => {
      console.log('Tunnel closed');
  });
})();
