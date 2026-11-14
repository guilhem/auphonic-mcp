# Auphonic MCP pour Sites

Portage JavaScript de [JupiterBroadcasting/auphonic-mcp](https://github.com/JupiterBroadcasting/auphonic-mcp) à partir de la version du serveur `fe143636bce036931019e350d7061f39dab68bb4` (identifiant du blob, licence MIT).

Le Worker fournit `POST /mcp` et `GET /health`. L’accès est contrôlé par Sites. Configurez `AUPHONIC_API_KEY` comme secret d’exécution. Les UUID de préréglage peuvent être passés directement ou associés à une émission via `AUPHONIC_PRESET_MON_PODCAST`. Pour retrouver automatiquement les pistes d’un épisode quand le préréglage n’en déclare aucune, définissez `AUPHONIC_TRACKS_MON_PODCAST` avec les noms des pistes séparés par des virgules.

Les fichiers d’entrée proviennent d’URL directes ou de services externes associés à Auphonic. Les outils de création enregistrent un brouillon par défaut. `action: "start"` ou `start_production` lance le traitement. `download_output` indique les sorties disponibles et renvoie vers la page de la production pour le téléchargement.

## Compiler et déployer

1. Exécuter `npm run build` puis `npm run validate` avec Node.js 22 ou plus récent.
2. Pour publier sur ChatGPT Sites, rattacher le dépôt à un nouveau site et laisser Sites renseigner son `project_id` dans `.openai/hosting.json`. Le manifeste déclare la capacité `mcp`.
3. Garder le site privé et définir le secret `AUPHONIC_API_KEY` avant de publier. Le Worker s’appuie sur le contrôle d’accès de Sites pour protéger ses outils et reçoit de Sites l’identité utilisée par le formulaire de téléversement.

## Téléverser des fichiers locaux

Le formulaire sur la page d’accueil envoie les fichiers à Auphonic sans les conserver sur le site. Il permet de créer un brouillon avec un mix ou 2 à 8 pistes distinctes, jusqu’à 90 Mio par fichier. En multipiste, choisir un préréglage multipiste et vérifier les noms proposés. En cas d’interruption, le même formulaire peut reprendre à la piste en cours tant que la page reste ouverte. Les fichiers plus volumineux peuvent être transmis avec les outils MCP depuis un stockage connecté ou une URL directe.

Le champ `file` de `upload_audio` accepte une pièce jointe ChatGPT si le client prend en charge les paramètres de fichier. Les champs `input_url` et `service` restent disponibles.
