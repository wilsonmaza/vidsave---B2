# Alterações desta versão

## Bugs corrigidos

- **O backend não arrancava.** `backend/src/server.js` importava `isAllowedHost`
  mas usava `isHostAllowed` (`ReferenceError` no arranque). Era a causa mais
  provável do "Servidor inacessível" em produção: com o processo a rebentar,
  o frontend nunca conseguia ligar.
- **`parseCorsOrigin` em falta** em `backend/src/config/env.js`: o teste
  `env.test.js` já o esperava. Agora `CORS_ORIGIN` aceita uma ou várias
  origens (separadas por vírgula) e ignora a barra final.
- **Log de arranque** passou a dizer "a ouvir na porta N", que é o que o
  teste de arranque procura.
- **Testes dependentes de DNS real.** 9 testes de rotas (`resolve.route`,
  `download.route.archive-org`) falhavam sem internet. `createApp()` aceita
  agora um `lookup` opcional; só os testes o usam. Produção não muda.
- **Frontend:** o `frontend/app.js` era o ecrã provisório da Etapa 1, com
  `http://localhost:3000` fixo e sem ler o `config.js`.

## Frontend novo (`frontend/`)

- Interface completa: colar link, verificar, escolher formato, descarregar.
- Cinco estados: `idle`, `processing`, `resolved`, `resolve-error`,
  `download-error`.
- Lê `API_BASE_URL` de `frontend/config.js`. Em produção, se estiver vazio,
  avisa em vez de tentar ligar a localhost.
- Tolera o arranque lento do plano gratuito da Render (avisa e volta a
  tentar durante ~90 s).
- Descarrega com progresso e nome `titulo.extensao` (só ASCII: alguns browsers
  ignoram o nome quando tem acentos). Ficheiros acima de 200 MB vão direto
  para o browser.
- Sem fontes externas (nada é enviado a terceiros). Espaço de publicidade
  reservado, desligado por defeito (`ADS_SLOT_VISIBLE`).
- Diz no ecrã que só o Internet Archive é suportado.

## Para pôr online

Ver "Publicar online (Vercel + Render)" no `README.md`. Resumo: backend na
Render com `CORS_ORIGIN` = domínio da Vercel; depois pôr o endereço da Render
em `frontend/config.js` (`API_BASE_URL`).

## Verificações feitas

- Backend: 315/315 testes a passar.
- Browser real (Chrome) contra o backend local: 20/20 verificações (os 5
  estados, download com nome certo, nova tentativa após erro, telemóvel).
- CORS restrito e provider de demonstração desligado em modo produção.

## Não verificado

- Deploy real na Render e na Vercel (não tenho acesso à Render daqui).
- Download de um item real do archive.org (os testes usam respostas simuladas).
