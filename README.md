# Web Extractor MCP

Petit MCP authentifié pour récupérer du texte public depuis X et inspecter le code public de pages web.

## Outils

- `get_tweet`: détecte automatiquement s’il s’agit d’un tweet ou d’un thread et renvoie tout le texte disponible.
- `get_page_code`: HTML, CSS/JS liés et métadonnées d’une page publique.
- `search_youtube_videos`: recherche YouTube sans clé API et renvoie des liens canoniques, titres, chaînes, dates, durées et vues. Essaie d’abord YouTube, puis deux miroirs publics si YouTube est inaccessible ou non analysable. Pour un résumé, ChatGPT peut transmettre l’URL canonique au plugin de transcription YouTube installé séparément.
- `fetch_public_data`: récupère les données brutes d’une URL ou d’une API publique (texte, JSON, HTML, XML, etc.). À utiliser pour les API publiques ou quand la réponse brute est demandée.
- `list_configured_api_providers`: liste les providers privés configurés et leurs domaines autorisés, sans jamais révéler les clés. À utiliser uniquement si l’utilisateur demande quelles API privées sont disponibles.
- `call_configured_api`: appelle une API privée avec sa clé serveur uniquement après une demande explicite de l’utilisateur pour cette API.
- `list_configured_api_providers` affiche aussi une UI MCP dans ChatGPT avec les noms, domaines et types d’authentification des providers. Les valeurs des clés ne sont jamais envoyées à l’UI.
- `save_configured_api_provider`: ajoute ou modifie les métadonnées d’un provider depuis l’UI sans accepter ni retourner de clé API. Les clés restent gérées exclusivement dans `/keys`.
- `inspect_url`: statut HTTP, redirections, headers et informations de base.

## Page des clés

`/keys` est disponible après connexion GitHub. Les clés API sont chiffrées avec `API_KEYS_ENCRYPTION_KEY` avant stockage dans KV. Les valeurs ne sont jamais renvoyées par l’interface ou les outils.

Pour l’instant, la page utilise aussi `ADMIN_PAGE_CODE` comme code d’accès privé. Ne mets jamais ce code, une clé API ou un secret GitHub dans le dépôt.

## Déploiement

Pour créer une instance indépendante, copier `wrangler.example.jsonc` vers `wrangler.jsonc`, puis remplacer le nom du Worker, `PUBLIC_ORIGIN` et l’identifiant KV par ceux de son propre compte Cloudflare. Ne jamais réutiliser le namespace KV d’une autre instance.

Créer un namespace KV nommé `OAUTH_KV`, puis configurer les secrets requis dans Cloudflare : `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_ALLOWED_LOGIN`, `ADMIN_PAGE_CODE` et `API_KEYS_ENCRYPTION_KEY`. Les valeurs réelles ne doivent jamais être ajoutées au dépôt. Configurer l’URL de callback GitHub OAuth sur `https://<PUBLIC_ORIGIN>/callback`, puis déployer avec `npm run deploy`.

Le fichier local `wrangler.jsonc`, `.dev.vars`, `.wrangler/`, les sauvegardes et les fichiers de test spécifiques à une instance sont exclus du dépôt.
