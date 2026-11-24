# VidSave

App web para descarregar vídeos a partir de um link, sem conta. O backend
(Node + Express) resolve o link e serve o ficheiro; o frontend
(HTML/CSS/JS puro) fica numa pasta separada e não tem build.

**Estado atual:** `POST /api/resolve`, `GET /api/download/:downloadId`
(uso único, com Size Guard e limpeza de ficheiros temporários), provider
real do Internet Archive e provider de demonstração (só dev). O único
provider real é o Internet Archive (`archive.org`) — o site diz isso
mesmo no ecrã, e só deve passar a anunciar outras plataformas quando o
provider respetivo existir. Ainda não há anúncios reais nem autenticação.

## Requisitos

- Node.js 18 ou superior

## Publicar online (Vercel + Render)

São duas peças separadas: o **frontend** na Vercel e o **backend** na
Render. O aviso "Servidor inacessível" aparece quando o frontend não
consegue falar com o backend, por isso o backend tem de estar online
primeiro.

1. **Backend na Render.** Render → New → Blueprint → escolher este
   repositório (usa o `render.yaml`). No serviço `vidsave-api`, em
   Environment, define `CORS_ORIGIN` com o domínio do frontend, **sem barra
   no fim** (ex.: `https://vidsave-bay.vercel.app`). Quando o deploy
   terminar, abre `https://<nome>.onrender.com/api/health` — tem de
   devolver `{"status":"ok", ...}`.
2. **Frontend na Vercel.** Em `frontend/config.js`, põe
   `API_BASE_URL: 'https://<nome>.onrender.com'` (HTTPS, sem barra no
   fim). Faz commit e push: a Vercel publica sozinha, porque o
   `vercel.json` já aponta para a pasta `frontend`.
3. **Confirmar.** Abre o site: o rodapé tem de dizer "Servidor ligado".

Notas:

- O plano gratuito da Render adormece o backend depois de cerca de 15
  minutos sem uso; o primeiro pedido depois disso pode demorar até um
  minuto. O site avisa o utilizador e volta a tentar sozinho.
- O disco do plano gratuito é temporário. Serve, porque os ficheiros do
  VidSave também são temporários (apagados após o download ou ao expirar).
- `DEMO_PROVIDER_ENABLED=false` em produção (já no `render.yaml`).
- Se o site mostrar "Não foi possível ligar ao servidor" com o backend
  online, o mais provável é `CORS_ORIGIN` errado (tem de ser exatamente o
  domínio do frontend).

## Como executar o backend

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

O servidor fica disponível em `http://localhost:3000` (porta configurável
via `PORT` no `.env`). `npm run dev` usa o watch mode nativo do Node
(`node --watch`) — reinicia sozinho quando um ficheiro muda, sem precisar
de nenhuma dependência extra.

## Como abrir o frontend

O frontend é HTML/CSS/JS puro, sem build step. Duas opções:

**Opção A — abrir diretamente**
Faz duplo clique em `frontend/index.html` (ou abre-o no browser via
`file://`).

**Opção B — servir localmente** (mais próximo do ambiente de produção)
```bash
cd frontend
npx serve .
```

Em qualquer dos casos, o backend tem de estar a correr para o health
check funcionar — a origem do CORS está aberta (`*`) só para este
ambiente de desenvolvimento.

## Testar `/api/health`

Com o backend a correr:

```bash
curl http://localhost:3000/api/health
```

Resposta esperada:

```json
{
  "status": "ok",
  "uptimeSeconds": 12,
  "timestamp": "2026-09-11T10:00:00.000Z"
}
```

Também dá para abrir `http://localhost:3000/api/health` diretamente no
browser, ou simplesmente carregar `frontend/index.html` com o backend
ligado — o indicador de estado no ecrã fica verde.

## Testar `POST /api/resolve`

Com o backend a correr:

```bash
curl -X POST http://localhost:3000/api/resolve \
  -H "Content-Type: application/json" \
  -d '{"url":"https://sample.test/demo/video-1"}'
```

Resposta esperada:

```json
{
  "success": true,
  "data": {
    "title": "VidSave — vídeo de demonstração 1",
    "thumbnail": null,
    "duration": 5,
    "formats": [
      { "formatId": "demo-video-1-720p", "quality": "720p", "format": "txt", "sizeBytes": 240 },
      { "formatId": "demo-video-1-480p", "quality": "480p", "format": "txt", "sizeBytes": 240 }
    ]
  }
}
```

Alguns casos de erro para experimentar:

```bash
# URL bloqueado pelo SSRF Guard -> 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/resolve \
  -H "Content-Type: application/json" -d '{"url":"http://localhost/x"}'

# Nenhum provider compatível -> 404
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/resolve \
  -H "Content-Type: application/json" -d '{"url":"http://93.184.216.34/x"}'

# Corpo sem "url" -> 400
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/resolve \
  -H "Content-Type: application/json" -d '{}'
```

## Correr os testes de segurança

```bash
cd backend
npm test
```

Usa o test runner nativo do Node (`node --test`), sem dependências extra.
122 testes no total (80 das Etapas 2/3/4 + 42 das Etapas 5/5.1) —
classificação de IPs, DNS/rebinding, redirects, timeouts, extração segura
de IP, rate limit, concorrência, validação de providers, registry, demo
provider, o pipeline completo de `/api/resolve` (unitário e via HTTP
real num servidor local efémero), e o mapeamento de erros. Nenhum teste
toca em rede real, timers reais, nem em nenhuma plataforma externa.

## Arquitetura de segurança (Etapa 2)

Três responsabilidades, três ficheiros, sem sobreposição:

- **`security/url-validator.js`** — só sintaxe: URL bem formado, protocolo
  `http`/`https`, comprimento máximo, sem credenciais embutidas. Não sabe
  nada sobre DNS nem sobre que domínios são permitidos.
- **`security/ssrf-guard.js`** — a proteção de rede em si: bloqueio de IPs
  privados/reservados (IPv4 e IPv6), resolução de DNS controlada com
  fixação do IP (anti-rebinding), e revalidação completa a cada redirect.
  Não conhece a allowlist do VidSave — recebe-a de fora, se o chamador
  quiser aplicá-la, via `isHostAllowed`.
- **`config/allowlist.js`** — só dados: a lista de domínios permitidos.
  Vazia nesta etapa, porque ainda não existe nenhum provider real.

**Como funciona o anti-SSRF:** cada hostname é resolvido via DNS, e
**todos** os endereços devolvidos (não só o primeiro) são verificados
contra uma lista de blocos reservados — RFC1918, loopback, link-local
(onde vive o endpoint de metadata `169.254.169.254`), carrier-grade NAT,
e os equivalentes em IPv6 (`::1`, `fc00::/7`, `fe80::/10`, incluindo
endereços IPv4 mapeados em IPv6). Se qualquer um for privado, o hostname
inteiro é rejeitado — mesmo que outro endereço da mesma resposta DNS
seja público.

**Como o IP é fixado:** depois de validado, o primeiro endereço é
"fixado" — a ligação HTTP real é forçada a usar exatamente esse IP,
através de uma função `lookup` customizada passada ao `Agent` do
http/https, que ignora qualquer hostname e devolve sempre o mesmo
endereço. Isto fecha a janela clássica de DNS rebinding: não há uma
segunda consulta de DNS entre a validação e o pedido real onde um atacante
pudesse trocar a resposta.

**Como os redirects são tratados:** o `Location` de uma resposta 3xx
nunca é seguido diretamente. O novo URL passa por todo o pipeline outra
vez — sintaxe, allowlist (se aplicável), DNS, fixação de IP — como se
fosse um pedido novo. Isto é o que bloqueia tanto um redirect direto para
um IP privado como um redirect para um hostname que resolve para um IP
privado. Há um limite configurável de saltos (`maxRedirects`, default 3).

**Mensagens de erro seguras:** todos os erros desta camada usam
`SecurityValidationError`, com uma mensagem pública fixa
("URL inválido ou não permitido.") independente do motivo real — o
motivo específico fica só em `err.detail`, para logs do servidor. Isto
evita que alguém a sondar o endpoint aprenda, pelas diferenças nas
mensagens, que endereços internos existem na rede.

### Limitações conhecidas desta etapa

- A resolução DNS usa `dns.promises.lookup`, que por defeito pode
  devolver resultados em cache do sistema operativo — não é uma
  resolução "pura" a cada chamada. Para o nível de proteção que
  precisamos (impedir rebinding *entre a validação e o pedido*, não
  entre pedidos diferentes), isto é suficiente, mas fica anotado.
- `ssrf-guard.js` ainda não está ligado a nenhum endpoint HTTP real —
  isso só faz sentido quando existir um provider a chamá-lo (Etapa 5).
- A lista de blocos reservados cobre os casos mais relevantes (RFC1918,
  loopback, link-local/metadata, carrier-grade NAT, documentação,
  multicast) mas não é uma tabela IANA exaustiva.

## Arquitetura de rate limiting e controlo de abuso (Etapa 3)

Quatro peças, cada uma com uma responsabilidade:

- **`security/client-ip.js`** — extrai o IP do cliente com segurança.
- **`security/rate-limiter.js`** — `MemoryRateLimiter` (janela fixa),
  `ConcurrencyLimiter` (semáforo por chave) e `createRateLimitMiddleware`
  (adapta um limiter para Express).
- **`config/env.js`** — lê a configuração do `.env` (nenhum valor fixo no
  código).
- `/api/resolve` já usa o rate limiter geral desta etapa (ver Etapa 5);
  `/api/download/:downloadId` ainda não existe.

### Estratégia escolhida

Janela fixa (*fixed window*) em memória, não *sliding window* nem
*token bucket*. É o suficiente para o volume de tráfego que existe agora
(zero) e é fácil de raciocinar sobre — a complexidade de um algoritmo mais
sofisticado só se justifica com tráfego real para o guiar.

A classe expõe só `consume(key)`, que devolve
`{ allowed, remaining, retryAfterMs }`. Uma futura `RedisRateLimiter`
(usando `INCR` + `PEXPIRE`, atómico) pode implementar o mesmo contrato e
substituir a `MemoryRateLimiter` sem tocar em controllers, rotas, ou no
`createRateLimitMiddleware`.

### Como o IP é identificado

Por defeito, `getClientIp()` usa sempre `req.socket.remoteAddress` — a
única fonte que um cliente não consegue falsificar — e **ignora
completamente** o `X-Forwarded-For`, mesmo que esteja presente. Confiar
nesse header sem um proxy conhecido à frente da app permitiria a qualquer
cliente inventar um IP diferente a cada pedido e contornar o rate limit
por completo.

Para ativar, define no `.env`:

```text
TRUST_PROXY=true
```

**Só ativa isto se a app estiver mesmo atrás de exatamente um proxy
confiável** (ex.: o load balancer da Render/Railway/Fly.io). Com
`TRUST_PROXY=true`, o último valor do `X-Forwarded-For` é usado — o único
que esse proxy pode ter adicionado ele próprio. Esta implementação não
resolve cadeias com mais do que um proxy à frente da app; isso exigiria
contar hops com uma topologia real para testar, que ainda não existe.

O middleware `attachClientIp({ trustProxy: env.trustProxy })` deve correr
antes de qualquer rate limiter, para que estes só leiam `req.clientIp`
sem cada um precisar de conhecer a configuração de proxy.

### Como funciona o controlo de concorrência

`ConcurrencyLimiter` é um semáforo por chave: `tryAcquire(key)` devolve
`{ acquired, release }`. Se `acquired` for `false`, a vaga não existe e o
pedido deve ser recusado. Se for `true`, o chamador deve invocar
`release()` num `finally`, para libertar a vaga mesmo que a operação
falhe a meio:

```js
const { acquired, release } = downloadConcurrencyLimiter.tryAcquire(req.clientIp);
if (!acquired) {
  return res.status(429).json({ error: 'Too many requests.' });
}
try {
  await streamDownloadToClient(); // ainda não existe
} finally {
  release();
}
```

### Configuração disponível

| Variável | Default | Efeito |
|---|---|---|
| `TRUST_PROXY` | `false` | Ativa a leitura do `X-Forwarded-For` (ver acima) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Duração da janela do limite geral por IP |
| `RATE_LIMIT_MAX_REQUESTS` | `15` | Pedidos permitidos por janela, limite geral |
| `RESOLVE_RATE_LIMIT_MAX` | `10` | Limite mais rigoroso, específico para `/api/resolve` |
| `DOWNLOAD_MAX_CONCURRENT_PER_IP` | `2` | Downloads simultâneos permitidos por IP |

### Limitações conhecidas desta etapa

- **Em memória, por processo.** Com uma única instância do backend (o
  caso do MVP), isto funciona corretamente. No momento em que correrem
  duas ou mais instâncias atrás de um load balancer, cada uma tem a sua
  própria contagem — um cliente pode efetivamente duplicar (ou mais) o
  limite real, porque cada instância só vê uma fração do seu tráfego.
  É exatamente por isto que `RedisRateLimiter` (um store central,
  partilhado por todas as instâncias) fica planeado como substituto,
  atrás do mesmo contrato `consume(key)`.
- `getClientIp` só resolve corretamente o caso de exatamente um proxy
  confiável — não uma cadeia com vários.
- O timer de limpeza usa `unref()`, o que é suficiente para não impedir o
  processo de terminar, mas cada instância de `MemoryRateLimiter` corre o
  seu próprio timer — aceitável para o número pequeno de limiters desta
  etapa (geral + resolve), não escalaria bem para dezenas deles.
- Testámos que o limiter aceita configuração explícita de janela/limite;
  não recarregámos `config/env.js` com valores de `.env` diferentes no
  mesmo processo de teste — exigiria truques de import dinâmico sem
  benefício real, já que a leitura em si é uma atribuição direta.

## Arquitetura de providers (Etapa 4)

```text
URL
 ↓
Provider Registry
 ↓
Provider compatível
```

Quatro ficheiros, cada um com uma responsabilidade:

- **`providers/provider.interface.js`** — não é uma interface real (JS não
  tem isso), é validação de forma: `isValidProvider()` / `assertValidProvider()`
  confirmam que um objeto tem `id`, `canHandle()`, `resolve()` e
  `getDownloadStream()` antes de ser aceite em qualquer lado.
- **`providers/registry.js`** — regista, encontra, ativa/desativa
  providers, e nada mais. Não sabe nada sobre o que cada provider faz
  internamente.
- **`providers/demo-provider.js`** — o primeiro (e único, por agora)
  provider real, usando só ficheiros locais do projeto.
- **`providers/bootstrap.js`** — o único sítio que decide que providers
  estão ativos, a partir da configuração. Controllers (quando existirem)
  nunca vão decidir isto sozinhos.

### O contrato do provider

```js
{
  id: string,
  canHandle(url: string): boolean,
  resolve(url: string): Promise<{ title, thumbnail, duration, formats }>,
  getDownloadStream(formatId: string): Promise<{ stream, contentType }>,
}
```

Cada formato em `formats[]` tem `formatId`, `quality`, `format` e
`sizeBytes`. Nenhum provider é uma classe com estado — são objetos
simples, sem `this.resolvedData` nem nenhuma variável partilhada entre
chamadas. `resolve(url)` recebe tudo o que precisa como argumento e
devolve um objeto novo; `getDownloadStream(formatId)` faz o mesmo. Isto
não é só estilo — é o que torna seguro chamar o mesmo provider para
pedidos concorrentes de utilizadores diferentes sem um pedido conseguir
ver ou alterar os dados de outro.

### O registry

`ProviderRegistry.findForUrl(url)` percorre os providers ativos, na
ordem em que foram registados, e devolve o primeiro cujo `canHandle(url)`
seja verdadeiro. Se nenhum for compatível — ou se o registry estiver
vazio — lança `ProviderNotFoundError`, com uma mensagem pública genérica
("Não conseguimos processar este link.") e o motivo real só em
`.detail`, seguindo o mesmo princípio dos erros da Etapa 2.

`register()` valida a forma do provider (via `assertValidProvider`) e
recusa um `id` duplicado com `DuplicateProviderError`. `setEnabled(id, bool)`
liga/desliga um provider já registado sem o remover — um provider
desativado é tratado exatamente como se não existisse, na procura.

### Como funciona o demo provider

Reconhece só URLs em `https://sample.test/demo/<item>` —
`sample.test` é um domínio reservado pela IANA (RFC 2606) especificamente
para documentação e testes, que nunca resolve na internet real, por isso
não há ambiguidade possível com uma plataforma verdadeira. Tem dois itens
fixos, definidos no próprio ficheiro (`video-1`, `video-2`), cada um
apontando para um ficheiro de texto em `providers/fixtures/` — claramente
identificado como não sendo um vídeo real. Não faz pedidos de rede, não
acede a nenhuma API externa, não interpreta nem contorna nada.

`resolve()` devolve sempre um objeto novo (título, duração, e um array de
formatos gerado de novo a cada chamada); `getDownloadStream()` abre um
`fs.createReadStream` sobre o ficheiro de fixture correspondente ao
`formatId` pedido.

### Confirmação: sem estado partilhado entre pedidos

Três testes provam isto especificamente, não só por inspeção do código:

1. Mutar o objeto devolvido por uma chamada a `resolve()` (mudar o título,
   fazer `push` num array de formatos) e confirmar que a chamada seguinte
   devolve os dados originais, intocados.
2. Chamar `resolve()` para dois itens diferentes em paralelo
   (`Promise.all`) e confirmar que cada resultado tem o título correto
   para o seu próprio URL — nunca misturado com o outro.
3. 20 chamadas concorrentes e intercaladas entre os dois itens, todas
   verificadas individualmente no fim.

Isto funciona porque `DEMO_ITEMS` é uma tabela constante, nunca mutada, e
cada método constrói objetos/arrays novos a cada chamada — não há
`this`, não há variável de módulo que guarde "o último pedido".

### Limitações conhecidas desta etapa

- O demo provider serve conteúdo de texto simples, não vídeo real — de
  propósito, para não precisar de nenhum ficheiro de media real só para
  provar que o pipeline funciona.
- O registry escolhe o primeiro provider compatível pela ordem de
  registo; com só um provider isto não importa, mas se dois providers
  reais um dia conseguirem tratar o mesmo URL, vai ser preciso decidir
  uma prioridade explícita.
- `bootstrap.js` só liga/desliga o demo provider por agora — ganha mais
  utilidade quando houver mais do que um provider real para configurar.

## Arquitetura do `POST /api/resolve` (Etapa 5)

```text
URL enviada pelo utilizador
        ↓
Rate Limiter (middleware, corre primeiro)
        ↓
resolve.controller — coordena, nunca decide
        ↓
resolve.service — o pipeline a sério:
    validar body → validar sintaxe do URL → SSRF Guard → Provider Registry → provider.resolve()
        ↓
Resposta JSON
```

`routes/resolve.routes.js` é deliberadamente fino — só liga
`POST /resolve` ao rate limiter e ao controller, ambos injetados.
`controllers/resolve.controller.js` chama o service, converte sucesso em
`{ success: true, data }`, e passa qualquer erro para o error-handler
partilhado via `next(err)` — não decide status codes nem formata
mensagens de erro, isso é feito num único sítio (ver Etapa 5.1).
`services/resolve.service.js` tem a lógica toda: reaproveita
`validateUrlSyntax` e `assertSafeHostname` da Etapa 2 tal como estão, e
`registry.findForUrl` da Etapa 4 tal como está — zero duplicação.

### Uma decisão que se desvia da ordem literal do pedido

O rate limiting corre como middleware do Express, **antes** do
controller — não depois da validação do body, como uma leitura literal
da lista numerada sugeria. Isto é intencional: middleware de rate limit
só faz sentido (e só foi construído, na Etapa 3) para correr o mais cedo
possível, rejeitando tráfego em excesso antes de gastar qualquer
trabalho a validar o que veio no pedido. O invariante que importa
mesmo — nenhum provider é chamado antes de todas as validações de
segurança passarem — continua garantido, e há um teste específico que
prova exatamente isso.

### sample.test e o SSRF Guard

O SSRF Guard corre por completo para **qualquer** URL, incluindo o do
demo provider — não haveria sentido em ter uma proteção que se desliga
sozinha para um caso específico. O problema é que `sample.test` (o
domínio do demo provider) é reservado pela IANA precisamente para nunca
ter DNS real, e uma resolução real falharia sempre.

A solução foi um `createLookupWithOverrides()` genérico em
`ssrf-guard.js` — não sabe nada sobre o VidSave, só envolve uma função de
lookup com um mapa de hostnames conhecidos. `resolve.service.js` é quem
decide que `sample.test` tem uma entrada fixa (um IP público qualquer,
nunca realmente contactado, já que o demo provider só lê ficheiros
locais). O bloqueio de IP continua a correr por cima desse endereço,
exatamente como para qualquer outro — não é um desvio da proteção, é dar-lhe
a resposta de DNS que `sample.test` teria se existisse. Qualquer outro
hostname continua a ir para `dns.promises.lookup` real.

### Exemplo de sucesso

```json
POST /api/resolve
{ "url": "https://sample.test/demo/video-1" }
```
```json
200 OK
{
  "success": true,
  "data": {
    "title": "VidSave — vídeo de demonstração 1",
    "thumbnail": null,
    "duration": 5,
    "formats": [
      { "formatId": "demo-video-1-720p", "quality": "720p", "format": "txt", "sizeBytes": 240 },
      { "formatId": "demo-video-1-480p", "quality": "480p", "format": "txt", "sizeBytes": 240 }
    ]
  }
}
```

### Erros e os seus status

| Situação | Status | Motivo da escolha |
|---|---|---|
| Body/URL inválidos, protocolo proibido, credenciais embutidas, SSRF bloqueado | `400` | Todos tratados como "o cliente enviou algo inaceitável" — consistente com o `status` que `SecurityValidationError` já tinha desde a Etapa 2 |
| Nenhum provider compatível (ou provider desativado) | `404` | Pedido especificamente por este enunciado |
| Rate limit excedido | `429` | Reaproveita o middleware da Etapa 3 tal como está |
| Erro do provider, metadata inválida, ou qualquer coisa inesperada | `500` | Mensagem genérica fixa, nunca o motivo real |

Todas as respostas de erro têm a mesma forma — `{ "error": "<mensagem>" }`
— incluindo o `429`, porque tudo passa pelo mesmo error-handler
partilhado (ver Etapa 5.1). Só a resposta de sucesso tem a forma mais
rica `{ success, data }`.

## Auditoria e hardening (Etapa 5.1)

Depois de ligar tudo, três problemas reais apareceram ao rever a
integração — nenhum tinha sido pego pelos testes da Etapa 5 porque só se
manifestam quando se pensa em o que acontece com dados **inesperados**,
não só com o caminho feliz.

### 1. `error-handler.js` confiava cegamente em `err.status`

O código original fazia `const status = err.status || 500;` para
**qualquer** erro. Isto significa que um erro de uma dependência
qualquer — ou um bug em qualquer sítio do código — que por acaso tivesse
um campo `.status` (mesmo sem ser um erro nosso, mesmo sem intenção)
seria tratado como se fosse seguro mostrar `err.message` ao cliente.

Corrigido com um mapeamento explícito e fechado,
`mapErrorToResponse(err)`: só `instanceof SecurityValidationError` ou
`instanceof ProviderError` (que cobre também `ProviderNotFoundError` e
`DuplicateProviderError`, por herança) podem influenciar o status ou a
mensagem — e mesmo assim, só se o `status` for um 4xx válido
(`400`–`499`). Um `ProviderError` construído com `status: 999`, `status:
200`, ou sem `status` nenhum, cai sempre no `500` genérico. Um `Error`
comum, mesmo com um `.status` coincidente, nunca é confiado.

### 2. Nada validava o que `provider.resolve()` devolvia

`assertValidProvider()` (Etapa 4) só confirma que um provider tem os
métodos certos — nunca verificou que `resolve()` devolve dados com a
forma certa. Um provider mal implementado (ou um futuro provider externo
com um bug) podia devolver `formats: []`, `title` em falta, ou
`sizeBytes` como string, e isso ia direto para a resposta HTTP.

Corrigido com `assertValidResolvedMedia()`, em
`provider.interface.js`, chamada uma vez em `resolve.service.js`, logo a
seguir a `provider.resolve()` — antes de o controller ver o resultado.
Valida `title` (string não vazia), `thumbnail`/`duration` (nulos ou do
tipo certo), e que `formats` é um array não vazio em que cada item tem
`formatId`/`quality`/`format` (strings não vazias) e `sizeBytes` (número
finito ≥ 0). Uma falha aqui é tratada como erro interno (`500`), nunca
como sucesso.

### 3. SSRF e rate limiting — confirmados, não alterados

Nenhum provider chama `ssrf-guard.js` diretamente, e a ordem em
`resolve.service.js` (sintaxe → SSRF → registry → provider) já garantia
que nenhum provider é sequer considerado antes do SSRF Guard passar —
isto ficou confirmado com um teste que usa um provider-espião que
aceitaria qualquer URL (`canHandle: () => true`) e prova que nunca chega
a ser chamado quando o URL é bloqueado. Quanto ao rate limiting: não há
"lock" para ficar preso — `MemoryRateLimiter.consume()` não tem
`release()`, incrementa sempre, mesmo quando o pedido falha depois (o que
é o comportamento certo: senão dava para contornar o limite enviando
pedidos inválidos de propósito). Confirmado com um teste dedicado.
`ConcurrencyLimiter` continua sem ser usado em `/api/resolve` — só faz
sentido para `/api/download`, que ainda não existe.

### Limitações conhecidas desta etapa

- `mapErrorToResponse` é uma lista fechada de duas classes-base. Um
  futuro terceiro tipo de erro conhecido (ex.: um erro específico de
  storage, na Etapa 6) vai precisar de ser adicionado explicitamente a
  este mapeamento — o que é a intenção: nada entra nesta lista por
  acidente.
- A validação de `ResolvedMedia` é estrutural (tipos e presença), não
  semântica — não verifica, por exemplo, que `duration` faz sentido para
  o `formats` devolvido. Isso teria pouco valor sem regras de negócio
  reais para validar contra.
- O log de `[resolve]` no controller regista só o hostname (nunca o path
  nem a query), mas os `.detail` dos erros da Etapa 2/4 — que aparecem
  no log de erro, nunca na resposta HTTP — ainda podem incluir o URL
  completo nalguns casos (ex.: "URL sintaticamente inválido: ..."). Isto
  é só para os logs do servidor, nunca chega ao cliente, mas fica
  anotado como algo a rever se o conteúdo de URLs for considerado
  sensível no futuro.

## Estrutura

```text
vidsave/
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── backend/
│   ├── src/
│   │   ├── server.js
│   │   ├── app.js
│   │   ├── routes/
│   │   │   ├── health.routes.js
│   │   │   └── resolve.routes.js
│   │   ├── controllers/
│   │   │   ├── health.controller.js
│   │   │   └── resolve.controller.js
│   │   ├── services/
│   │   │   └── resolve.service.js
│   │   ├── middleware/error-handler.js
│   │   ├── security/
│   │   │   ├── url-validator.js
│   │   │   ├── ssrf-guard.js
│   │   │   ├── client-ip.js
│   │   │   └── rate-limiter.js
│   │   ├── providers/
│   │   │   ├── provider.interface.js
│   │   │   ├── registry.js
│   │   │   ├── demo-provider.js
│   │   │   ├── bootstrap.js
│   │   │   └── fixtures/
│   │   │       ├── demo-video-1.txt
│   │   │       └── demo-video-2.txt
│   │   └── config/
│   │       ├── env.js
│   │       └── allowlist.js
│   ├── test/
│   │   ├── middleware/
│   │   │   └── error-handler.test.js
│   │   ├── security/
│   │   │   ├── url-validator.test.js
│   │   │   ├── ssrf-guard.test.js
│   │   │   ├── client-ip.test.js
│   │   │   └── rate-limiter.test.js
│   │   ├── providers/
│   │   │   ├── provider-interface.test.js
│   │   │   ├── registry.test.js
│   │   │   ├── demo-provider.test.js
│   │   │   └── bootstrap.test.js
│   │   ├── services/
│   │   │   └── resolve.service.test.js
│   │   └── routes/
│   │       └── resolve.route.test.js
│   ├── package.json
│   └── .env.example
├── .gitignore
└── README.md
```

### Limitações conhecidas da Etapa 1

- `CORS_ORIGIN` fica em `*` quando não está definido (dev local). Em
  produção tem de ser o domínio do frontend (uma origem, ou várias
  separadas por vírgula); o servidor avisa nos logs se ficar em `*`.
- `API_BASE_URL` é configurável em `frontend/config.js`.
