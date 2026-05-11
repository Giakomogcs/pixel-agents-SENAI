# Como o OpenCode conecta no GitHub Copilot — explicado pra leigo

> Documento de referência para quem quer construir um app próprio que se autentica no GitHub Copilot, baseado em como o DynamicFront/OpenCode resolvem isso hoje.

---

## A ideia em 1 parágrafo

O GitHub Copilot **não tem "API key"** que você compra e cola num campo. O acesso a ele é uma **assinatura amarrada à sua conta do GitHub**. Então, em vez de pedir uma chave, o OpenCode pede pro GitHub: *"deixa esse app aqui usar o Copilot em nome desse usuário"*. O GitHub responde com um **código curto** (tipo `ABCD-1234`), o usuário **abre o navegador, faz login no GitHub e cola o código**, e pronto — o GitHub devolve um **token de acesso** que o OpenCode guarda em disco e usa daí pra frente como se fosse uma API key.

Esse fluxo tem nome oficial: **OAuth 2.0 Device Authorization Grant** (ou só "device flow").

---

## Por que device flow (e não OAuth normal de site)?

OAuth tradicional (o "login com Google" de site) precisa de um **redirect URL**: o usuário clica, vai pro GitHub, autoriza, e o GitHub **redireciona o navegador de volta** pro seu site com um código.

Isso **não funciona** quando quem está pedindo acesso é:

- um **CLI** rodando no terminal,
- um **container Docker** sem navegador,
- um **app desktop**,
- ou qualquer coisa que **não tenha uma URL pública pra receber o redirect**.

O device flow resolve exatamente isso: separa **quem pede** (o app, sem navegador) de **quem autoriza** (o humano, no navegador, em outro dispositivo se quiser).

---

## Os 5 passos do device flow (genérico, qualquer app)

```
┌────────────┐                              ┌──────────────┐
│  Seu app   │                              │   GitHub     │
└─────┬──────┘                              └──────┬───────┘
      │                                            │
   1. │ POST /login/device/code                    │
      │  client_id=..., scope=...                  │
      │ ─────────────────────────────────────────► │
      │                                            │
   2. │ ◄───── { device_code, user_code,           │
      │          verification_uri, interval }      │
      │                                            │
      │  "Mostre 'ABCD-1234' pro usuário e         │
      │   peça pra abrir github.com/login/device"  │
      │                                            │
┌─────▼──────┐                                     │
│  Usuário   │  3. Abre navegador, cola ABCD-1234, │
│ (humano)   │     faz login, clica "Authorize"    │
└─────┬──────┘ ───────────────────────────────────►│
      │                                            │
   4. │ POST /login/oauth/access_token             │
      │  device_code=..., client_id=...            │
      │ ─────────────────────────────────────────► │
      │ ◄── { access_token } (ou "ainda esperando")│
      │     (faz polling a cada `interval` seg)    │
      │                                            │
   5. │ Usa o access_token nas chamadas:           │
      │  Authorization: Bearer <token>             │
      │ ─────────────────────────────────────────► │
```

**Tradução pra leigo:**

1. App diz pro GitHub "quero acesso, me dá um código".
2. GitHub manda dois códigos: um **secreto** (pro app guardar) e um **curto e bonitinho** (pro humano digitar).
3. Humano abre o navegador, digita o código, autoriza.
4. App fica perguntando "já autorizou? já autorizou?" até o GitHub responder "sim, toma o token".
5. App usa o token pra falar com a API do Copilot.

---

## Como o OpenCode implementa isso (e o que o DynamicFront aproveita)

O OpenCode **encapsula tudo** num SDK. O DynamicFront só chama dois métodos:

### Passo A — começar o flow

`backend/src/providers/providers.service.ts` (linhas 287–307)

```ts
const result = await client.provider.oauth.authorize({
  path: { id: 'copilot' },
  body: { method: 0 },
});
// result.data = { url, instructions }
//   url           → "https://github.com/login/device"
//   user code     → vem dentro de `instructions`
```

É o equivalente aos **passos 1+2** do diagrama: o OpenCode fala com o GitHub, recebe `device_code` (guarda internamente) + `user_code` (devolve pro DynamicFront mostrar na tela).

### Passo B — esperar o usuário autorizar

`backend/src/providers/providers.service.ts` (linhas 311–337)

```ts
const result = await client.provider.oauth.callback({
  path: { id: 'copilot' },
  body: { method: 0 },
});
// result.data === true   → autorizou! token salvo
// result.data === false  → ainda esperando, chame de novo
```

É o **passo 4** com polling. O frontend do DynamicFront chama esse endpoint a cada poucos segundos até virar `true`.

### Passo C — usar o token

Quando vira `true`, o OpenCode escreve o `access_token` num arquivo **`auth.json`** dentro do diretório `.opencode` do container daquele usuário. Daí em diante, qualquer requisição pro Copilot é feita com `Authorization: Bearer <token>` automaticamente — **o DynamicFront nem vê o token**.

Por isso o serviço chama `restartUserInstance(userId)` no fim: pra recarregar o container já lendo o `auth.json` novo.

---

## Pra você fazer seu próprio projeto que conecta no Copilot

Você tem **3 caminhos**, em ordem de esforço:

### Caminho 1 — Mais fácil: usar o `@opencode-ai/sdk` direto

Instala o SDK e chama `client.provider.oauth.authorize/callback` igual o DynamicFront faz. Você não escreve nada de OAuth, só UI.

- **Prós:** zero criptografia, zero polling manual.
- **Contras:** acopla seu projeto ao OpenCode (que é um runtime grande).

### Caminho 2 — Médio: usar o GitHub CLI OAuth App

O GitHub publica um **`client_id` público oficial do GitHub CLI** (`Iv1.b507a08c87ecfe98`) que **já tem permissão pra Copilot**. Você usa ele direto na API de device flow do GitHub:

```
POST https://github.com/login/device/code
  client_id=Iv1.b507a08c87ecfe98
  scope=read:user
```

Depois faz polling em:

```
POST https://github.com/login/oauth/access_token
  client_id=Iv1.b507a08c87ecfe98
  device_code=<o que veio antes>
  grant_type=urn:ietf:params:oauth:grant-type:device_code
```

Com o token na mão, troca por um **token de Copilot** (curto, expira em ~30min):

```
GET https://api.github.com/copilot_internal/v2/token
  Authorization: token <github_token>
→ { token: "tid=...", expires_at: 1234567890 }
```

E aí finalmente chama o Copilot:

```
POST https://api.githubcopilot.com/chat/completions
  Authorization: Bearer <copilot_token>
  Editor-Version: MyApp/1.0
  Editor-Plugin-Version: MyApp/1.0
  (payload formato OpenAI)
```

- **Prós:** sem dependência de SDK, controle total.
- **Contras:** você cuida do refresh do `copilot_token` a cada 30 min, e está usando o `client_id` do CLI (não-oficialmente suportado pra terceiros — pode quebrar).

### Caminho 3 — "Certo": registrar seu próprio GitHub OAuth App

1. Vai em **GitHub → Settings → Developer settings → OAuth Apps → New**.
2. Marca a opção **"Enable Device Flow"**.
3. Pega seu próprio `client_id`.
4. Faz o flow igual ao Caminho 2, mas **com seu client_id**.

- **Prós:** legítimo, seu nome aparece na tela de autorização.
- **Contras:** um OAuth App **comum** **não tem acesso ao endpoint do Copilot** — o GitHub só libera Copilot pro app oficial do CLI/IDEs. Pra acesso oficial à API do Copilot você precisa entrar no programa de **Copilot Extensions/GitHub Apps** (mais burocrático).

> Resumindo a real: hoje, **fora dos editores oficiais**, todo mundo que conecta no Copilot (incluindo o OpenCode) está usando o `client_id` do GitHub CLI. Funciona, mas é "área cinza".

---

## Checklist mínimo do seu projeto

1. **Tela 1 (start):** botão "Conectar com GitHub Copilot". Clicou → backend chama device flow → mostra **código grande** (`ABCD-1234`) + botão "Abrir GitHub" (`https://github.com/login/device`).
2. **Polling:** backend pergunta ao GitHub a cada 5s "já autorizou?". Frontend mostra spinner.
3. **Sucesso:** salva `github_access_token` (criptografado!) no banco, ligado ao `userId`.
4. **Refresh do copilot_token:** antes de cada chamada, se `expires_at` passou, troca o `github_access_token` por um novo `copilot_token` no `/copilot_internal/v2/token`.
5. **Chat:** chama `https://api.githubcopilot.com/chat/completions` com headers `Editor-Version` e `Editor-Plugin-Version` (sem eles o GitHub bloqueia).
6. **Logout:** apaga o token do banco. Pronto.

---

## Anexo — Onde está cada coisa no DynamicFront

| O quê                                        | Arquivo                                              |
| -------------------------------------------- | ---------------------------------------------------- |
| Força `authMethods=['oauth']` pra Copilot    | `backend/src/providers/providers.service.ts` L78–98  |
| `startOAuth` (passo A)                       | `backend/src/providers/providers.service.ts` L287    |
| `completeOAuth` + polling (passo B)          | `backend/src/providers/providers.service.ts` L311    |
| Endpoints HTTP                               | `backend/src/providers/providers.controller.ts` L94+ |
| Fallback de `COPILOT_API_KEY` / `GITHUB_TOKEN` via env | `backend/src/opencode/opencode.service.ts` L1226+ |

**Importante:** nenhum `client_id`, `client_secret` ou token do Copilot está em `.env` — tudo é OAuth por usuário, persistido no `auth.json` do container OpenCode daquele user.
