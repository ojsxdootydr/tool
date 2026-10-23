// Base de conhecimento usada na verificacao de tweets (lupa), no resumo de pagina e nas perguntas.
// Montada em out/2026 a partir de documentacao oficial, estudos e relatorios publicados (fontes no fim de cada item).
// Nao sao dados por moeda: sao taxas-base e padroes. Atualize quando sair dado novo.
const BASE_PUMP = `
BASE DE CONHECIMENTO SOBRE PUMP.FUN E MEMECOINS (dados publicados, com data; use como referencia, nao como certeza):

Taxas-base (o que acontece com a maioria):
- Graduacao (sair da bonding curve para o PumpSwap) e rara e varia muito por periodo: ~0,84% em abr/2026 (763 mil lancamentos), ~0,26% em meados de jun/2026, ~1,7% de 23/jun a 19/jul/2026 (693 mil lancamentos), com pico de ~6,7% em um dia logo apos o recurso BOOST (jul/2026). Historico acumulado: menos de 2% dos tokens ja graduaram. Mudancas na plataforma mexem muito nesse numero.
- Chegar a US$1M de market cap e muito mais raro que graduar (contagem de 2024: ~89 moedas acima de US$1M entre ~2 milhoes lancadas).
- ~97% das memecoins morrem ou perdem quase todo o volume (Binance Research). Estudo de ago/2026 com 6,4 milhoes de tokens Solana: a grande maioria mostra caracteristicas de rug pull ja na primeira hora; os primeiros 5 minutos de negociacao bastaram para prever boa parte dos rugs. Tratar qualquer moeda nova como "provavelmente perde" ate haver motivo concreto.
- Na Solana, rug pull vem principalmente de manipulacao de liquidez e dinamica social (venda coordenada, hype falso), NAO de codigo malicioso no contrato (mint e freeze ja vem revogados nos tokens da pump.fun).

Taxas oficiais da pump.fun (documentacao oficial, out/2026):
- Na bonding curve: 1,25% por trade (0,30% para o criador, 0,95% para a plataforma).
- Depois de graduar (PumpSwap): o criador ganha 0,95% por trade entre 420 e 1.470 SOL de market cap, e a parte dele cai por faixas ate 0,05% acima de 98 mil SOL. O criador lucra com volume, entao tem incentivo para gerar hype e giro, mesmo sem projeto real.

O que as graduadas "de verdade" tem (analise de abr/2026):
- Graduacao acontece cedo ou nao acontece: mediana ~10 min, 62% em ate 10 min, 85% em ate 1 hora.
- Graduadas reais: mediana ~312 compradores unicos e ~853 trades; graduadas de bot: ~6 compradores e ~8 trades (~24% das graduacoes diarias sao de bot). Menos de ~20 compradores unicos = suspeito.
- Antes de graduar, compra supera venda: razao compradores/vendedores mediana ~1,57; acima de 2,0 e sinal forte.
- Sinal do criador (jun-jul/2026, 816 tokens): carteira que ja graduou um token antes e ficou pelo menos 7 dias sem lancar graduou 12% das vezes, contra ~1,7% da media. Mesmo assim 88 de cada 100 falharam. Lancador em serie (varios tokens por dia) e sinal ruim.

Limites usados por ferramentas de risco (RugCheck / Solana Tracker):
- Top 10 holders com mais de 15% do supply: perigo.
- Snipers ou insiders (carteiras ligadas ao criador) com mais de 20%: perigo; mais de 10%: alerta.
- Bundlers (compras coordenadas no lancamento) com mais de 15%: perigo; mais de 5%: alerta.
- Dev com mais de 10% do supply: perigo; mais de 5%: alerta.
- Liquidez nao queimada/bloqueada, mint ou freeze authority ativas: perigo. Token sem redes sociais: alerta.

Golpes que aparecem no proprio tweet (casos documentados):
- Conta grande ou oficial hackeada postando o contrato (CA) de um token "oficial", de "governanca" ou de "recompensa" que o projeto nunca anunciou: aconteceu com as contas da pump.fun, Jupiter DAO, dogwifhat e Nasdaq (2024-2025). O token sobe rapido (ate dezenas de milhoes de market cap), os golpistas vendem em minutos e o post e apagado.
- Varios contratos postados e apagados em sequencia pela mesma conta.
- Endosso de famoso ou parceria sem prova nos canais oficiais do suposto parceiro.
- Nome/ticker copiando moeda famosa; conta criada ha poucos dias se passando por pessoa ou projeto que ja existia (conta nova de projeto novo e normal); urgencia artificial ("ultima chance", "vai explodir"); promessa de retorno garantido ou de pagamento em SOL.
- Contrato divulgado fora dos canais oficiais do projeto: confirmar o CA no site oficial ou na conta verificada.

Padroes de narrativa que viraram grandes (Moo Deng, PNUT, GOAT, Fartcoin, Chill Guy):
- Narrativa entendida em 3 segundos, ligada a um evento viral real e recente (animal famoso, noticia, meme do momento, pessoa ou conta que ja tem atencao). Quanto mais cedo depois do evento, melhor; moeda atrasada vira exit liquidity.
- Amplificacao por contas grandes no X (KOLs) e liquidez baixa fazem o preco subir rapido; o ciclo inteiro de alta e queda costuma durar 3 a 7 dias.
- Listagem em exchange ou rotacao de capital de moedas ja valorizadas ajudaram as grandes: catalisador externo, nao algo que o criador controla.
- Novidades da plataforma geram ondas curtas: a primeira moeda boa do formato ganha, as copias nao.

Sinais bons: dev identificado e que ja entregou algo, supply bem distribuida, compradores unicos crescendo, razao compradores/vendedores acima de 1,5, narrativa que ja existia fora do cripto, CA confirmado em canal oficial.

Como julgar uma IDEIA, FERRAMENTA ou ESTRATEGIA:
- Funciona so se resolver algo que realmente atrapalha quem negocia ou lanca (velocidade, informacao antes dos outros, evitar rug). Se qualquer um copia em 1 dia, a vantagem some.
- Se depende de bots, snipers ou volume falso, ou de uma funcao da plataforma que pode mudar, o risco e alto.
- Desconfie de promessa de retorno, de "metodo" sem prova e de lucro que depende de achar compradores depois (esquema piramidal disfarcado).
- Informacao nova so vale se chegar ANTES do mercado; noticia que ja esta no feed geralmente ja esta no preco.
`;

// Glossario de TERMOS (sem estatisticas e sem julgar moeda): ajuda a lupa e o resumo a explicar girias e funcoes das plataformas
// que aparecem nos tweets (ex.: "sem cashback"). Montado em out/2026; atualize quando a plataforma mudar.
const GLOSSARIO = `
GLOSSARY (use it to explain a term when it shows up in the tweet; never to judge the coin):
Platforms:
- pump.fun: anyone launches a Solana memecoin in seconds.
- Bonding curve: a coin's first phase on pump.fun; price rises as people buy. "Graduate"/"migrate" = complete the curve and move to PumpSwap (pump.fun's DEX).
- Creator fee: share of every trade's fee that goes to the coin creator (0.3% on the curve, up to 0.95% after graduating).
- Cashback (Cashback Coins): pump.fun launch mode (Feb 2026) where 100% of the creator fee went back to traders. Chosen before launch and locked. Removed in Sep 2026. "No cashback" = standard mode (creator keeps the fee).
- Holder Rewards: replaced Cashback (Sep 2026); splits fees among holders several times per hour.
- Axiom: memecoin trading platform; "Pulse" is the feed of new coins, each with the tweet that inspired it.
- "Paid" badge on a token: its profile was paid for (e.g. on DexScreener); says nothing about quality.
Trading slang:
- CA: contract address. MC/mcap: market cap. ATH: all-time high.
- Dev: coin creator. "Dev sold": creator sold their share. CTO (community takeover): community took over after the dev left.
- Rug/rug pull: scam where whoever controls the coin pulls liquidity or dumps everything. Honeypot: you can buy but not sell.
- Bundle/bundler: several wallets of the same owner buy together at launch. Sniper: bot buying in the first seconds. Insider: wallet linked to the dev.
- KOL: influencer. Shill: promote a coin (usually because they hold it).
- Ape/ape in: buy without thinking. Jeet: sells at the first profit. Paper hands / diamond hands: sells easily / holds to the end.
- Cooked: done, finished. Send it: it will pump. Moon/mooning: go up a lot. Pump/dump: strong rise/fall.
- Bull/bullish: optimistic, market up. Bear/bearish: pessimistic, market down.
- Exit liquidity: late buyers who let early holders sell. Bag/bagholder: stuck holding a coin that fell.
- Runner: coin that can keep going up a lot.
- LP burned: liquidity burned (dev cannot pull it). Mint/freeze revoked: dev cannot mint more or freeze wallets.
- Narrative/meta: the trending theme pumping coins (animals, AI, a celebrity).
`;
