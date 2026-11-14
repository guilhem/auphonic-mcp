# Auphonic MCP pour Sites

Portage JavaScript de [JupiterBroadcasting/auphonic-mcp](https://github.com/JupiterBroadcasting/auphonic-mcp) à partir de la version du serveur `fe143636bce036931019e350d7061f39dab68bb4` (identifiant du blob, licence MIT).

Le Worker fournit `POST /mcp` et `GET /health`. L’accès est contrôlé par Sites. Configurez `AUPHONIC_API_KEY` comme secret d’exécution. Les UUID de préréglage peuvent être passés directement ou associés à une émission via `AUPHONIC_PRESET_MON_PODCAST`. Pour retrouver automatiquement les pistes d’un épisode quand le préréglage n’en déclare aucune, définissez `AUPHONIC_TRACKS_MON_PODCAST` avec les noms des pistes séparés par des virgules.

Les fichiers d’entrée proviennent de pièces jointes, d’URL directes ou de services externes associés à Auphonic. Les outils de création enregistrent un brouillon par défaut. `action: "start"` ou `start_production` lance le traitement, qui peut consommer des crédits et publier vers les destinations configurées.

## Compiler et déployer

1. Exécuter `npm run build` puis `npm run validate` avec Node.js 22 ou plus récent.
2. Pour publier sur ChatGPT Sites, rattacher le dépôt à un nouveau site et laisser Sites renseigner son `project_id` dans `.openai/hosting.json`. Le manifeste déclare la capacité `mcp`.
3. Garder le site privé et définir le secret `AUPHONIC_API_KEY` avant de publier. Le Worker s’appuie sur le contrôle d’accès de Sites pour protéger ses outils et reçoit de Sites l’identité utilisée par le formulaire de téléversement.

## Téléverser des fichiers locaux

Le formulaire sur la page d’accueil envoie les fichiers à Auphonic sans les conserver sur le site. Il permet de créer un brouillon avec un mix ou 2 à 8 pistes distinctes, jusqu’à 90 Mio par fichier. En multipiste, choisir un préréglage multipiste et vérifier les noms proposés. En cas d’interruption, le même formulaire peut reprendre à la piste en cours tant que la page reste ouverte. Les fichiers plus volumineux peuvent être transmis avec les outils MCP depuis un stockage connecté ou une URL directe.

Le champ `file` de `upload_audio` accepte une pièce jointe ChatGPT si le client prend en charge les paramètres de fichier. Les champs `input_url` et `service` restent disponibles.

### Multipiste depuis le MCP

Joindre deux à huit enregistrements à la conversation, puis appeler `create_multitrack_from_files` avec les pièces jointes dans `files` et les noms correspondants dans `track_names`. Par exemple, pour `hote.wav` puis `invite.wav`, utiliser `track_names: ["Hôte", "Invité"]`. Le client MCP doit prendre en charge les paramètres de fichier. Un chemin local seul ne transmet pas le fichier au serveur. Le serveur accepte jusqu’à 2048 Mio par pièce jointe, sous réserve des limites du client.

Le Worker crée un seul brouillon Auphonic et envoie les enregistrements en multipart, chacun dans le champ portant le nom de sa piste. Les pistes fournies remplacent la liste des pistes multipistes du préréglage. `dry_run: true` affiche l’association piste–fichier, les suppressions et les réglages hérités. `start_multitrack_production` reste disponible pour les URL, les services Auphonic et les clients qui utilisaient déjà son contrat.

### Parcours des outils

1. `list_presets` puis `get_preset` pour connaître les pistes, les traitements, les sorties et les destinations. `list_services` et `list_service_files` permettent d’explorer les sources externes.
2. `create_production` pour préparer un brouillon et ses pistes. `upload_production_file` ajoute ou remplace le fichier d’une piste sur le même UUID. `update_production` modifie les métadonnées et les réglages du brouillon.
3. `check_status` affiche les réglages effectifs du brouillon et indique s’il est prêt à démarrer. En cas d’erreur partielle d’upload, la réponse inclut l’UUID et les pistes manquantes lorsque leur état peut être relu.
4. `start_production` lance le traitement. `list_outputs` indique les fichiers disponibles et `download_output` permet de sélectionner un nom exact. Le lien télécharge le fichier depuis le site privé après connexion.

Les résultats MCP contiennent un objet `structuredContent` en plus du texte. Les listes y sont sous `items`. Les erreurs exposent un code et, selon le cas, l’UUID de production et l’action suivante.

### Régler un brouillon avant traitement

`check_status` affiche les algorithmes du master et des pistes, les débits et formats de sortie, le moteur et la langue de transcription, les destinations et les champs `review_before_publishing` et `in_review` tels que les renvoie Auphonic.

`update_production` prend l’UUID du brouillon et applique les réglages fournis, puis relit la production. Le traitement et la publication se lancent séparément. Les algorithmes du master s’envoient dans `algorithms`, et ceux d’une piste dans `multi_input_files` avec son `id` exact. Le décalage existant est conservé si `offset` et `keep_offset` sont omis.

Exemple d’arguments, avec les UUID et le nom de piste renvoyés par `check_status` :

```json
{
  "production_uuid": "<uuid-du-brouillon>",
  "algorithms": { "leveler": true, "sync_tracks": true, "silence_cutter": false },
  "multi_input_files": [{ "id": "Hôte", "algorithms": { "denoise": true } }],
  "remove_outgoing_services": ["<uuid-internet-archive>"],
  "review_before_publishing": true
}
```

`output_files` et `outgoing_services` définissent la liste finale lorsqu’ils sont fournis. Une liste vide retire ses éléments et un champ omis évite de remplacer la liste. Auphonic peut ajouter des formats lors de l’activation de la transcription. Envoyez `speech_recognition: { "language": "fr" }` pour Whisper, ajoutez `uuid` pour un moteur externe, ou envoyez `null` pour désactiver la transcription. `in_review` est un état géré par Auphonic, distinct du réglage `review_before_publishing`.

Certaines modifications prennent plusieurs appels à Auphonic. En cas d’échec, l’outil indique les étapes terminées et le dernier état qu’il a pu relire. Vérifiez cet état avant de recommencer.

Pour demander le nivellement Standard, utilisez `algorithms: { "levelermode": "standard" }` sans fournir `maxlra`, `maxs` ni `maxm`. Ces valeurs sélectionnent les réglages Broadcast, y compris à 0 (Auto). Le MCP vérifie le `levelermode` renvoyé par Auphonic. Si Auphonic conserve Broadcast sur le brouillon existant, sélectionnez le mode Standard dans l’éditeur Auphonic et vérifiez avec `check_status`.

La validation avant publication s’applique lorsqu’une destination est configurée. `check_status` distingue l’absence de destination de la validation désactivée. `update_production` demande et vérifie la validation par défaut lors d’un ajout de destination. Si un brouillon a des destinations et que la validation est inactive, `start_production` bloque le démarrage, sauf autorisation explicite avec `allow_automatic_publication: true`.
