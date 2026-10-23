AXIOM HELPER  (versão 4.6)

Instalar (Chrome)
1. Abra chrome://extensions
2. Ligue o "Modo do desenvolvedor" (canto superior direito).
3. Clique em "Carregar sem compactação" e escolha esta pasta.
4. Abra a axiom.trade ou a gmgn.ai, aperte F5 e passe o mouse sobre um tweet
   (no Pulse do Axiom ou no balão de tweet da GMGN).

Usar
- Os tweets do balão são traduzidos sozinhos. Passe o mouse no texto para ver o original.
- Uma barrinha fica em cima do balão:
    文A     liga ou desliga a tradução automática
    Linhas  resume o tweet (só em tweets longos)
    Lupa    analisa a narrativa: quem postou, o que diz, de onde vem o hype
            e se é real (olha primeiro as fontes do próprio tweet e lê as imagens)
- Botão direito em qualquer site > "Resumir esta página" (inclui testes básicos do site).
  Fora do Axiom e da GMGN a extensão só entra na página quando você clica nisso.
- Na barrinha também aparecem selos grátis, sem IA: a idade da conta (só informação; conta nova
  é normal em projeto novo) e o contrato (CA) citado no tweet, que copia com um clique.
- Clique no ícone da extensão para abrir as configurações. "Traduzir para" escolhe a língua
  das traduções, dos resumos e das análises. A interface existe em português, espanhol e inglês.

Custos
- A tradução é grátis.
- Resumos, análises e resumos de página usam a API do Claude (paga, com a sua chave) e
  só rodam quando você clica. O gasto aparece nas configurações.

Se nada for traduzido
- Aperte F5 no Axiom / GMGN depois de instalar ou atualizar a extensão.
- Em chrome://extensions, clique em "Erros" ou em "service worker" na extensão e veja as mensagens.

Testes (para quem mexe no código)
- Com o Node instalado, rode nesta pasta:  node testes/testar.js
  Confere a proteção das gírias na tradução, os textos da interface e o manifest.

Mudanças da 4.6
- A extensão não é mais carregada em todo site: só no Axiom e na GMGN. Nos outros sites
  ela entra apenas quando você usa "Resumir esta página".
- Interface em espanhol.
- "token" e "ticker" não são mais traduzidos (o tradutor trocava token por "ficha").
- O tradutor do Chrome agora também respeita as gírias protegidas (antes só o Google respeitava).
- Nomes de cripto em chinês saem com o nome certo (币安 vira Binance, não "segurança de moedas").
- Gírias da BSC (four.meme, flap) não são traduzidas.
- Mais rápido: o tweet completo é buscado (de graça) assim que o balão abre, então o resumo e a lupa
  começam na hora do clique. O resumo do tweet aparece enquanto a IA escreve.
- Selos na barrinha: idade da conta e contrato do tweet (clique para copiar).
- Com o Sonnet 5.5, a busca na web usa a versão nova, que filtra o resultado e gasta menos tokens.
- A análise não trata mais conta nova, sozinha, como risco.
- Preço do Sonnet 5.5 no medidor de gasto corrigido (US$ 2 / US$ 10 por milhão de tokens).
- Limpeza de configurações antigas só roda ao atualizar, não a cada início.
- Testes automáticos em testes/testar.js.
- A versão anterior (4.5) está guardada em backup-v4.5.
