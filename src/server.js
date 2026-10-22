import { config } from './config.js';
import { createAppServer } from './app.js';
import { checkSecurityConfig } from './auth.js';

const { fatal, warnings } = checkSecurityConfig();
if (fatal) {
  console.error(`[auth] ${fatal}`);
  process.exit(1);
}
for (const warning of warnings) {
  console.warn('!'.repeat(60));
  console.warn(`  [auth] ${warning}`);
  console.warn('!'.repeat(60));
}

const server = createAppServer();

server.listen(config.port, () => {
  console.log('─'.repeat(60));
  console.log(`  AI Phone Call Translator listening on :${config.port}`);
  console.log(`  TwiML webhook : POST /twilio/incoming-call`);
  console.log(`  Media stream  : WS   /twilio/media-stream`);
  console.log(`  Dashboard     : http://localhost:${config.port}/`);
  console.log(`  Dashboard WS  : WS   /dashboard/ws?sessionId=<id>`);
  console.log(`  Sessions API  : GET  /api/sessions`);
  console.log(`  Dashboard auth: ${config.dashboardToken ? 'DASHBOARD_TOKEN' : 'DISABLED (no DASHBOARD_TOKEN)'}`);
  console.log(`  Twilio sigs   : ${config.twilioAuthToken && !config.twilioSkipSignatureCheck ? 'verified' : 'NOT verified'}`);
  console.log(`  Languages     : ${config.speakerALang}  ⇄  ${config.speakerBLang}`);
  console.log(`  Voice         : ${config.voice}  (clone bridge: ${config.enableVoiceClone ? 'ON' : 'off'})`);
  console.log('─'.repeat(60));
});
