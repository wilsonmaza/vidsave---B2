import { createApp } from './app.js';
import { env } from './config/env.js';
import { isAllowedHost } from './config/allowlist.js';

// B2 — é aqui, no arranque real do servidor (nunca em createApp() por
// omissão, para não alterar o comportamento dos testes existentes — ver
// app.js), que a verificação antecipada de allowlist em
// resolve.service.js fica realmente ligada. O archive-org-provider já
// usa a allowlist real por omissão de qualquer forma (ver bootstrap.js);
// isto acrescenta a rejeição ANTES de sequer resolver o provider.
const app = createApp({ isHostAllowed: isAllowedHost });

// Em produção, CORS aberto a qualquer origem deixa qualquer site usar o
// backend como API sua. Não bloqueamos o arranque (um deploy de teste
// pode precisar disto), mas o aviso fica bem visível nos logs.
if (env.nodeEnv === 'production' && env.corsOrigin === '*') {
  console.warn(
    '[config] AVISO: CORS_ORIGIN não está definido (ou é "*") em produção. ' +
      'Define-o com o domínio do frontend, ex.: https://vidsave-bay.vercel.app'
  );
}

const server = app.listen(env.port, () => {
  console.log(`VidSave backend a ouvir na porta ${env.port} (${env.nodeEnv})`);
});

// Etapa 6.4 — Inicia limpeza de órfãos
app.orphanCleanup.start();

// Graceful shutdown: pára cleanup e fecha o servidor
process.on('SIGTERM', () => {
  console.log('[server] Recebido SIGTERM, encerrando...');
  app.orphanCleanup.stop();
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[server] Recebido SIGINT, encerrando...');
  app.orphanCleanup.stop();
  server.close(() => {
    process.exit(0);
  });
});
