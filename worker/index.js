const serverInfo = { name: "auphonic-mcp", version: "1.4.0" };
const version = "2026-07-28";
const capabilities = { tools: {}, resources: {}, prompts: {} };
const text = (description) => ({ type: "string", description });
const integer = (description, minimum = 0) => ({ type: "integer", description, minimum });
const productionId = text("Auphonic production UUID");
const presetFields = {
  preset: text("UUID du préréglage Auphonic. Prioritaire si show est aussi renseigné."),
  show: text("Alias d’émission configuré par le propriétaire. Fournissez preset ou show."),
};
const actionField = { type: "string", enum: ["save", "start"], description: "save enregistre un brouillon par défaut. start peut consommer des crédits et déclencher les publications du préréglage." };
const titleField = text("Titre de l’épisode");
const tools = {};
function tool(name, description, properties, required, annotations, run) {
  tools[name] = { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations, run };
}
const readOnly = { readOnlyHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const uuid = (value, field) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new ToolError("INVALID_ARGUMENT", field + " invalide.");
  return value;
};
const productionPath = (id) => "/production/" + uuid(id, "production_uuid");
const productionUrl = (id) => "https://auphonic.com" + productionPath(id);
const records = (value) => Array.isArray(value) ? value : Object.values(value ?? {});
const preview = (value) => ![false, 0, null, undefined, "", "false", "0", "no", "off"].includes(typeof value === "string" ? value.trim().toLowerCase() : value);

class ToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function publicMessage(message, env) {
  const key = env.AUPHONIC_API_KEY?.trim();
  const safe = key ? message.replaceAll(key, "[secret]") : message;
  return safe.replace(/https?:\/\/[^\s<>"']+/g, (url) => url.split(/[?#]/)[0]).slice(0, 500);
}

function action(value = "save") {
  if (!["save", "start"].includes(value)) throw Error("action doit valoir save ou start.");
  return value;
}

function presetFor(args, env) {
  const show = args.show?.trim().toUpperCase().replaceAll("-", "_");
  if (show && !/^[A-Z0-9_]+$/.test(show)) throw new ToolError("INVALID_ARGUMENT", "Nom d’émission invalide.");
  const preset = args.preset ?? (show ? env["AUPHONIC_PRESET_" + show] : undefined);
  if (!preset) throw new ToolError("PRESET_REQUIRED", "Fournissez un UUID de list_presets ou un alias d’émission configuré.", { next_action: "list_presets" });
  return uuid(preset, "preset");
}

async function api(env, path, { method = "GET", body, query, multipart, timeout = 15000 } = {}) {
  const key = env.AUPHONIC_API_KEY?.trim();
  if (!key) throw Error("Ajoutez AUPHONIC_API_KEY aux secrets du site.");
  const url = new URL("https://auphonic.com/api" + path);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  const headers = { Authorization: "Bearer " + key, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (multipart) headers["Content-Type"] = multipart.contentType;
  const response = await fetch(url, {
    method, headers, redirect: "manual",
    body: multipart?.body ?? (body === undefined ? undefined : JSON.stringify(body)),
    ...(multipart ? { duplex: "half" } : {}),
    signal: AbortSignal.timeout(timeout),
  }).catch(() => {
    throw new ToolError("AUPHONIC_UNREACHABLE", "Auphonic ne répond pas.", { retryable: method === "GET" });
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || Number(result.status_code) >= 400) {
    const status = Number(result?.status_code) || response.status;
    const detail = typeof result?.error_message === "string" ? publicMessage(result.error_message, env) : "";
    throw new ToolError(status === 404 ? "NOT_FOUND" : "AUPHONIC_ERROR",
      "Auphonic HTTP " + status + (detail ? " — " + detail : ""), {
        upstream_status: status, retryable: method === "GET" && (status === 429 || status >= 500),
      });
  }
  return result.data;
}

function fileLabel(value) {
  if (!value) return undefined;
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    const basename = url.pathname.split("/").filter(Boolean).at(-1);
    return basename ? url.origin + "/" + basename : url.origin;
  } catch { return "[URL]"; }
}

function outputDetails(files) {
  return (files ?? []).map(({ size, ...file }) => ({ ...pickFields(file, outputFields), size_bytes: size }));
}

function destinations(data) {
  return (data?.outgoing_services ?? []).map((service) => ({
    uuid: service.uuid, name: service.display_name, type: service.type, transfer_success: service.transfer_success,
    settings: serviceSettings(service),
  }));
}

function trackDetails({ id, type, input_file, service, algorithms, offset, keep_offset }) {
  return { id, type, file: fileLabel(input_file), has_input: Boolean(input_file), service, algorithms, offset_seconds: offset, keep_offset };
}

function processingDetails(data) {
  const speech = data?.speech_recognition;
  return {
    algorithms: data?.algorithms,
    output_basename: data?.output_basename,
    speech_recognition: speech && Object.keys(speech).length ? { ...pickFields(speech, speechFields), type: speech.type } : null,
    review_before_publishing: data?.review_before_publishing,
    in_review: data?.in_review,
    outputs: outputDetails(data?.output_files),
    destinations: destinations(data),
  };
}

function productionDetails(data, fallback, env = {}) {
  const id = data?.uuid ?? fallback;
  return {
    uuid: id, url: id ? productionUrl(id) : undefined, title: data?.metadata?.title,
    status: data?.status, status_string: data?.status_string, length: data?.length,
    updated_at: data?.change_time, is_multitrack: data?.is_multitrack,
    start_allowed: data?.start_allowed, change_allowed: data?.change_allowed,
    error: data?.error_message ? { status: data.error_status, message: publicMessage(data.error_message, env) } : undefined,
    warnings: data?.warning_message ? [{ status: data.warning_status, message: publicMessage(data.warning_message, env) }] : [],
    input_file: fileLabel(data?.input_file), tracks: (data?.multi_input_files ?? []).map(trackDetails),
    ...processingDetails(data),
  };
}

function presetDetails(data, id) {
  return {
    uuid: data?.uuid ?? id, preset_name: data?.preset_name, is_multitrack: data?.is_multitrack,
    tracks: (data?.multi_input_files ?? []).map(trackDetails), ...processingDetails(data),
  };
}

function remoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error("Indiquez une URL HTTP(S) directe pour le fichier audio."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw Error("Indiquez une URL HTTP(S) directe pour le fichier audio, sans identifiants intégrés.");
  }
  return value;
}

async function resolveService(env, reference) {
  if (!reference?.trim()) return undefined;
  const lookup = reference.trim();
  const services = records(await api(env, "/services.json"));
  const matches = services.filter((service) => service.uuid === lookup ||
    service.display_name?.toLowerCase() === lookup.toLowerCase());
  if (matches.length !== 1) throw new ToolError(matches.length ? "AMBIGUOUS_SERVICE" : "NOT_FOUND",
    matches.length ? "Nom de service ambigu. Utilisez son UUID." : "Service Auphonic introuvable.");
  if (matches[0].incoming === false) throw new ToolError("INVALID_ARGUMENT", "Ce service est réservé à la publication.");
  return uuid(matches[0].uuid, "service");
}

tool("list_presets", "Liste les préréglages Auphonic et leurs UUID.", {}, [], readOnly, async (args, env) =>
  records(await api(env, "/presets.json", { query: { minimal_data: 1 } })).map(({ uuid, preset_name, is_multitrack }) => ({ uuid, preset_name, is_multitrack })));

tool("get_preset", "Consulte le mode mono ou multipiste, les pistes, les traitements, les sorties et les destinations d’un préréglage. Fournissez preset ou show.", presetFields, [], readOnly, async (args, env) => {
  const id = presetFor(args, env);
  return presetDetails(await api(env, "/preset/" + id + ".json"), id);
});

tool("list_services", "Liste les services Auphonic configurés et indique ceux qui acceptent des fichiers en entrée.", {}, [], readOnly, async (args, env) =>
  records(await api(env, "/services.json")).map(({ uuid, display_name, type, incoming, outgoing }) =>
    ({ uuid, name: display_name, type, incoming, outgoing })));

tool("list_service_files", "Liste les fichiers média accessibles sur un service d’entrée Auphonic.", {
  service: text("UUID ou nom exact renvoyé par list_services"),
}, ["service"], readOnly, async ({ service }, env) => {
  const id = await resolveService(env, service);
  if (!id) throw new ToolError("INVALID_ARGUMENT", "Indiquez un service d’entrée.");
  return { service: id, files: records(await api(env, "/service/" + id + "/ls.json")).filter((file) => typeof file === "string") };
});

tool("list_productions", "Liste les productions Auphonic avec pagination et filtre de statut.", {
  limit: { ...integer("Nombre de résultats (20 par défaut)", 1), maximum: 100 },
  offset: integer("Décalage de pagination"), status: integer("Code de statut Auphonic"),
}, [], readOnly, async (args, env) => records(await api(env, "/productions.json", {
  query: { limit: args.limit ?? 20, offset: args.offset, status: args.status, minimal_data: 1 },
})).map((item) => productionDetails(item, undefined, env)));

tool("check_status", "Consulte le statut et les réglages effectifs d’une production, dont les algorithmes du master et des pistes, les débits de sortie, la transcription et la validation avant publication.", {
  production_uuid: productionId,
}, ["production_uuid"], readOnly, async ({ production_uuid }, env) =>
  productionDetails(await api(env, productionPath(production_uuid) + ".json"), production_uuid, env));

const outputFilter = {
  production_uuid: productionId, format: text("Format ou extension (mp3, flac, vtt…)"),
  filename: text("Nom exact du fichier renvoyé par list_outputs"),
};

async function listOutputs({ production_uuid, format, filename }, env, origin) {
  const data = await api(env, productionPath(production_uuid) + ".json");
  const files = outputDetails((data?.output_files ?? []).filter((file) =>
    (!format || file.format === format || file.ending === format) && (!filename || file.filename === filename)));
  for (const file of files) {
    file.available = data.status === 3 && Boolean(resultFileUrl(data, production_uuid, file.filename));
    if (file.available && origin) {
      const query = new URLSearchParams({ production: production_uuid, filename: file.filename });
      file.download_url = origin + "/api/output?" + query;
    }
  }
  return { uuid: production_uuid, url: productionUrl(production_uuid), status: data?.status, files };
}

tool("list_outputs", "Liste les fichiers de sortie, leur disponibilité et les liens de téléchargement lorsque le traitement est terminé.", outputFilter, ["production_uuid"], readOnly, listOutputs);

tool("download_output", "Renvoie les liens de téléchargement depuis le site privé. Utilisez filename pour choisir un fichier précis.", outputFilter, ["production_uuid"], readOnly, async (args, env, origin) => {
  const result = await listOutputs(args, env, origin);
  if (result.status !== 3) throw new ToolError("PRODUCTION_NOT_READY", "La production n’est pas terminée.", {
    production_uuid: args.production_uuid, next_action: "check_status",
  });
  const files = result.files.filter((file) => file.available);
  if (!files.length) throw new ToolError("OUTPUT_NOT_FOUND", "Aucun fichier téléchargeable ne correspond à la sélection.", {
    production_uuid: args.production_uuid, next_action: "list_outputs",
  });
  return { ...result, files };
});

tool("start_production", "Démarre le traitement d’un brouillon complet. Peut consommer des crédits et publier vers les destinations configurées.", {
  production_uuid: productionId,
}, ["production_uuid"], write, async ({ production_uuid }, env) => {
  const path = productionPath(production_uuid);
  const draft = await api(env, path + ".json");
  if (draft?.start_allowed === false || (uploadableStatuses.has(draft?.status) && !hasRequiredInputs(draft))) {
    throw new ToolError("PRODUCTION_NOT_READY", "Auphonic ne permet pas de démarrer cette production ou des fichiers d’entrée manquent.", {
      production_uuid, next_action: "check_status",
    });
  }
  return productionDetails(await api(env, path + "/start.json", { method: "POST" }), production_uuid, env);
});

tool("delete_production", "Supprime définitivement une production Auphonic.", {
  production_uuid: productionId,
}, ["production_uuid"], { ...write, destructiveHint: true, idempotentHint: true }, async ({ production_uuid }, env) => {
  await api(env, productionPath(production_uuid) + ".json", { method: "DELETE" });
  return { deleted: production_uuid };
});

const attachment = {
  type: "object",
  properties: { download_url: text("URL temporaire de la pièce jointe"), file_id: text("Identifiant du fichier"),
    mime_type: text("Type MIME"), file_name: text("Nom du fichier") },
  required: ["download_url", "file_id"], additionalProperties: false,
};
const attachments = { type: "array", items: attachment, minItems: 2, maxItems: 8,
  description: "Deux à huit pièces jointes audio dans l’ordre de track_names. Limite serveur de 2048 Mio par fichier, sous réserve des limites du client." };
const trackNames = { type: "array", items: text("Nom unique de la piste Auphonic"), minItems: 2, maxItems: 8,
  description: "Deux à huit noms de pistes. Si files est renseigné, fournir un nom par fichier dans le même ordre." };

tool("upload_audio", "Crée une production à partir d’une pièce jointe ChatGPT, d’une URL audio directe ou d’un fichier sur un service Auphonic. Enregistre un brouillon par défaut.", {
  ...presetFields, file: { ...attachment, description: "Pièce jointe ChatGPT. Utilisez file seul, input_url seul ou service et input_file ensemble." }, input_url: text("URL HTTP(S) directe ou présignée"), service: text("UUID ou nom du service externe Auphonic"),
  input_file: text("Nom du fichier sur le service externe"), title: titleField, subtitle: text("Sous-titre"),
  summary: text("Résumé"), type: text("Tag de catégorie"), action: actionField,
}, [], write, async (args, env) => {
  const mode = action(args.action);
  const preset = presetFor(args, env);
  if (args.file) {
    if (args.input_url !== undefined || args.service !== undefined || args.input_file !== undefined) throw new UploadInputError("Indiquez une seule source audio.");
    const source = await openAttachment(args.file);
    return await uploadSingle(env, { ...args, preset, mode }, source);
  }
  const fromService = Boolean(args.service?.trim() && args.input_file?.trim());
  if (args.input_url !== undefined ? args.service !== undefined || args.input_file !== undefined : !fromService) {
    throw new UploadInputError("Fournissez input_url, ou bien service et input_file ensemble.");
  }
  const service = fromService ? await resolveService(env, args.service) : undefined;
  const metadata = { title: args.title, subtitle: args.subtitle, summary: args.summary, tags: args.type ? [args.type] : undefined };
  const body = {
    preset, service, input_file: fromService ? args.input_file : remoteUrl(args.input_url), metadata,
    action: mode === "start" ? mode : undefined,
  };
  return productionDetails(await api(env, "/productions.json", { method: "POST", body }), undefined, env);
});

tools.upload_audio._meta = { "openai/fileParams": ["file"] };

function stemLabel(filename) {
  const base = filename.replace(/\.[a-z0-9]{2,5}$/i, "");
  const separator = base.lastIndexOf("- ");
  return base.slice(separator < 0 ? 0 : separator + 2).trim().toLowerCase();
}

async function inferTracks(env, service, episode, names) {
  if (!service || !Number.isSafeInteger(episode) || episode < 1 || !names.length) {
    throw Error("Indiquez tracks, ou service et episode avec les pistes définies dans le préréglage ou dans AUPHONIC_TRACKS_<SHOW>.");
  }
  const listing = records(await api(env, "/service/" + service + "/ls.json"));
  const episodePattern = new RegExp("(?:^|\\s)0*" + episode + "(?=\\s|\\(|\\.|-|$)");
  const files = listing.filter((file) => typeof file === "string").map((file) => {
    try { return decodeURIComponent(file); } catch { return file; }
  }).filter((file) => episodePattern.test(file));
  return names.map((name) => {
    const matching = files.filter((file) => stemLabel(file) === name.toLowerCase());
    const plain = matching.filter((file) => !file.includes("(Ads)"));
    const candidates = plain.length ? plain : matching;
    if (candidates.length !== 1) throw Error(candidates.length ? "Fichiers ambigus pour la piste " + name : "Fichier introuvable pour la piste " + name);
    return [name, candidates[0]];
  });
}

tool("start_multitrack_production", "Crée un brouillon multipiste. Fournissez preset ou show et choisissez une source : files avec track_names, tracks explicites, ou service avec episode. Les pistes fournies remplacent les pistes multipistes du préréglage. dry_run affiche le plan.", {
  ...presetFields, service: text("UUID ou nom du service externe Auphonic"), episode: integer("Numéro d’épisode pour identifier les fichiers", 1),
  tracks: { type: "object", additionalProperties: { type: "string" }, description: "Association piste → URL directe, ou piste → fichier si service est renseigné." },
  files: attachments, track_names: trackNames,
  skip_tracks: { type: "array", items: { type: "string" } }, title: titleField,
  basename: text("Nom de base des fichiers de sortie"), action: actionField, dry_run: { type: "boolean" },
}, [], write, async (args, env) => {
  const mode = action(args.action);
  const preset = presetFor(args, env);
  if (args.files) return await uploadMultitrack(env, args, preset, mode);
  if (args.track_names) throw new UploadInputError("Fournissez les pièces jointes dans files avec track_names.");
  if (args.tracks && args.episode !== undefined) throw new UploadInputError("Fournissez tracks ou episode, selon la source choisie.");
  const config = await api(env, "/preset/" + preset + ".json");
  if (config?.is_multitrack === false) throw new UploadInputError("Sélectionnez un préréglage multipiste.");
  const existing = (config?.multi_input_files ?? []).filter((track) => track.type === "multitrack" && track.id);
  const byId = new Map(existing.map((track) => [track.id.toLowerCase(), track]));
  const show = args.show?.trim().toUpperCase().replaceAll("-", "_") ??
    Object.keys(env).find((key) => key.startsWith("AUPHONIC_PRESET_") && env[key] === preset)?.slice("AUPHONIC_PRESET_".length);
  const configured = (env["AUPHONIC_TRACKS_" + show] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const skip = new Set((args.skip_tracks ?? []).map((id) => id.trim().toLowerCase()));
  const names = (existing.length ? existing.map((track) => track.id) : configured).filter((name) => !skip.has(name.toLowerCase()));
  const service = await resolveService(env, args.service);
  const candidates = args.tracks === undefined
    ? await inferTracks(env, service, args.episode, names)
    : Object.entries(args.tracks);
  const entries = candidates.map(([name, file]) => [name.trim(), file]).filter(([name]) => !skip.has(name.toLowerCase()));
  if (!entries.length || entries.some(([name, file]) => !name || typeof file !== "string" || !file.trim())) throw new UploadInputError("Indiquez au moins une piste avec un nom et un fichier.");
  entries.forEach(([name]) => trackName(name));
  const ids = new Set(entries.map(([name]) => name.toLowerCase()));
  if (ids.size !== entries.length) throw Error("Les noms de pistes doivent être uniques.");
  if (new Set(entries.map(([, file]) => file)).size !== entries.length) throw Error("Chaque piste doit utiliser un fichier distinct.");
  const template = existing.find((track) => track.algorithms && Object.keys(track.algorithms).length)?.algorithms;
  const keep = [];
  const append = [];
  for (const [name, file] of entries) {
    if (service && /^[a-z]+:\/\//i.test(file)) throw Error("Avec service, indiquez les noms des fichiers sur ce service.");
    const track = byId.get(name.toLowerCase());
    const input = { type: "multitrack", id: track?.id ?? name, service, input_file: service ? file : remoteUrl(file) };
    if (track) keep.push(input);
    else append.push({ ...input, algorithms: template });
  }
  const drop = existing.filter((track) => !ids.has(track.id.toLowerCase())).map((track) => track.id);
  const create = { preset, is_multitrack: true, metadata: args.title ? { title: args.title } : undefined, output_basename: args.basename };
  if (preview(args.dry_run)) {
    return {
      dry_run: true, create, drop, start: mode === "start",
      fill: keep.map((track) => ({ ...trackDetails(track), input_file: fileLabel(track.input_file), algorithms: byId.get(track.id.toLowerCase())?.algorithms })),
      append: append.map((track) => ({ ...trackDetails(track), input_file: fileLabel(track.input_file) })),
      preset_settings: presetDetails(config, preset),
    };
  }
  const created = await api(env, "/productions.json", { method: "POST", body: create });
  const id = uuid(created?.uuid, "UUID de la production créée");
  const path = productionPath(id);
  try {
    for (const track of keep) {
      await api(env, path + "/multi_input_files/" + encodeURIComponent(track.id) + ".json", { method: "POST", body: track });
    }
    for (const name of drop) {
      await api(env, path + "/multi_input_files/" + encodeURIComponent(name) + ".json", { method: "DELETE" });
    }
    if (append.length) {
      await api(env, path + ".json", { method: "POST", body: { multi_input_files: append } });
    }
    const saved = await api(env, path + ".json");
    const actual = (saved?.multi_input_files ?? []).filter((track) => track.type === "multitrack");
    if (actual.length !== ids.size || new Set(actual.map((track) => track.id?.toLowerCase())).size !== ids.size ||
        actual.some((track) => !ids.has(track.id?.toLowerCase()) || !track.input_file)) {
      throw Error("Les pistes enregistrées diffèrent des pistes attendues.");
    }
    if (mode === "start") return await tools.start_production.run({ production_uuid: id }, env);
    return productionDetails(saved, id, env);
  } catch (error) {
    throw await draftError(error, env, id);
  }
});

tools.start_multitrack_production._meta = { "openai/fileParams": ["files"] };

tool("create_multitrack_from_files", "Crée un brouillon multipiste à partir de pièces jointes ChatGPT. Fournissez preset ou show et associez chaque fichier à son nom de piste par position. Les pistes fournies remplacent les pistes multipistes du préréglage. dry_run affiche le plan.", {
  ...presetFields, files: attachments, track_names: trackNames, title: titleField,
  basename: text("Nom de base des fichiers de sortie"), dry_run: { type: "boolean" },
}, ["files", "track_names"], write, async (args, env) => uploadMultitrack(env, args, presetFor(args, env), "save"));
tools.create_multitrack_from_files._meta = { "openai/fileParams": ["files"] };

tool("create_production", "Crée un brouillon vide. Fournissez preset ou show. Avec track_names, ces noms remplacent les pistes multipistes du preset. Ajoutez ensuite les fichiers avec upload_production_file, puis vérifiez le brouillon avant de le démarrer.", {
  ...presetFields, track_names: trackNames, title: titleField, basename: text("Nom de base des fichiers de sortie"),
}, [], write, async (args, env) => {
  const preset = presetFor(args, env);
  if (args.track_names) {
    const plan = await planUploadDraft(env, { ...args, preset, names: args.track_names });
    return createUploadDraft(env, plan);
  }
  return productionDetails(await api(env, "/productions.json", { method: "POST", body: {
    preset, metadata: args.title ? { title: args.title } : undefined, output_basename: args.basename,
  } }), undefined, env);
});

const bool = (description) => ({ type: "boolean", description });
const number = (description) => ({ type: "number", description });
const strings = (description) => ({ type: "array", items: { type: "string" }, description });
const object = (properties, description, required = []) => ({ type: "object", properties, additionalProperties: false, required, description });
const trackAlgorithmFields = {
  filtering: bool("Activer le filtrage"), filtermethod: text("Méthode de filtrage ou d’amélioration"),
  denoise: bool("Activer le débruitage"), denoisemethod: text("Méthode de débruitage"),
  denoiseamount: number("Réduction du bruit en dB"), dehum: number("Fréquence du ronflement en Hz"),
  levelerstrength: number("Intensité du nivellement en pourcentage"), gain: number("Gain de la piste en dB"),
  pan: text("Panoramique stéréo"), backforeground: text("Rôle de la piste dans le mixage"),
};
const masterAlgorithmFields = {
  leveler: bool("Activer le nivellement"), loudnesstarget: number("Cible de sonie en LUFS"),
  maxpeak: number("Limite de crête en dBTP"), gate: bool("Activer le noise gate multipiste"),
  crossgate: bool("Réduire les reprises de voix entre micros"), sync_tracks: bool("Synchroniser les pistes"),
  silence_cutter: bool("Couper les silences"), filler_cutter: bool("Couper les hésitations"),
  cough_cutter: bool("Couper les toux"), music_cutter: bool("Couper la musique"),
  cut_mode: text("Mode d’application des coupes"),
};
const algorithmSettings = (properties, description) => ({ type: "object", properties, minProperties: 1, additionalProperties: true, description });
const outputFields = {
  format: text("Format Auphonic, par exemple mp3, flac, tracks, transcript ou subtitle"),
  bitrate: integer("Débit en kbit/s", 0), ending: text("Extension"), filename: text("Nom de fichier complet"),
  suffix: text("Suffixe du nom de fichier"), mono_mixdown: bool("Mixage mono"),
  split_on_chapters: bool("Découpage par chapitre"), outgoing_services: strings("UUID des destinations de cette sortie"),
  burn_in_subtitles: { type: "object", additionalProperties: true, description: "Style complet des sous-titres incrustés dans une sortie vidéo" },
};
const speechFields = {
  uuid: text("UUID du service de transcription externe. Omettez uuid pour sélectionner Auphonic Whisper."),
  language: text("Langue de transcription, par exemple fr ou auto pour Whisper, fr-FR pour un moteur externe"),
  keywords: strings("Mots-clés de transcription"), shownotes: bool("Générer les notes et chapitres automatiques"),
  shownotes_summary_example: text("Exemple de résumé pour les notes"),
  speaker_diarization_num_speakers: { ...integer("Nombre de locuteurs pour Whisper", 1), type: ["integer", "null"] },
  speaker_diarization_names: { ...strings("Noms des locuteurs pour Whisper"), type: ["array", "null"] },
};
const serviceFields = {
  uuid: text("UUID de la destination renvoyé par check_status ou list_services"),
  sharing: text("Visibilité SoundCloud ou Spreaker"), downloadable: bool("Autoriser le téléchargement"),
  track_type: text("Type de piste SoundCloud"), privacy: text("Visibilité YouTube"), category: text("Catégorie YouTube"),
  distribution: text("Distribution Facebook"), embeddable: bool("Autoriser l’intégration Facebook"),
  draft: bool("Enregistrer en brouillon chez le diffuseur"), type: text("Type d’épisode chez le diffuseur"),
  show: text("Émission Spreaker"), podcast: text("Identifiant du podcast RSS.com"),
};

function pickFields(data, fields) {
  return Object.fromEntries(Object.keys(fields).filter((key) => Object.hasOwn(data ?? {}, key)).map((key) => [key, data[key]]));
}

function serviceSettings(service) {
  const { uuid, type, ...settings } = pickFields(service, serviceFields);
  if (settings.podcast && typeof settings.podcast === "object") settings.podcast = settings.podcast.id;
  return settings;
}

function algorithmPatch(algorithms) {
  const { cutter, levelermode, ...settings } = algorithms ?? {};
  return settings;
}

function matchesSetting(actual, wanted) {
  if (Array.isArray(wanted)) return Array.isArray(actual) && wanted.length === actual.length &&
    wanted.every((value, index) => matchesSetting(actual[index], value));
  if (wanted && typeof wanted === "object") return Boolean(actual) &&
    Object.entries(wanted).every(([key, value]) => matchesSetting(actual[key], value));
  return actual === wanted || (typeof wanted === "number" && typeof actual === "string" && actual.trim() !== "" && Number(actual) === wanted);
}

function verifyProductionChanges(args, saved) {
  const mismatches = [];
  for (const field of ["title", "subtitle", "summary"]) {
    if (args[field] !== undefined && args[field] !== saved?.metadata?.[field]) mismatches.push(field);
  }
  if (args.basename !== undefined && args.basename !== saved?.output_basename) mismatches.push("basename");
  if (args.algorithms && !matchesSetting(saved?.algorithms, algorithmPatch(args.algorithms))) mismatches.push("algorithms");
  for (const track of args.multi_input_files ?? []) {
    const actual = saved?.multi_input_files?.find((input) => input.type === "multitrack" && input.id === track.id);
    if (!actual || (track.algorithms && !matchesSetting(actual.algorithms, algorithmPatch(track.algorithms))) ||
      (track.offset !== undefined && !matchesSetting(actual.offset, track.offset)) ||
      (track.keep_offset !== undefined && actual.keep_offset !== track.keep_offset)) mismatches.push("multi_input_files:" + track.id);
  }
  if (args.speech_recognition === null && Object.keys(saved?.speech_recognition ?? {}).length) mismatches.push("speech_recognition");
  if (args.speech_recognition) {
    const actual = saved?.speech_recognition;
    if (!matchesSetting(actual, args.speech_recognition) ||
      (args.speech_recognition.uuid === undefined && actual?.type !== "whisper")) mismatches.push("speech_recognition");
  }
  if (args.review_before_publishing !== undefined && saved?.review_before_publishing !== args.review_before_publishing) {
    mismatches.push("review_before_publishing");
  }
  const services = saved?.outgoing_services ?? [];
  if (args.outgoing_services && (services.length !== args.outgoing_services.length ||
    args.outgoing_services.some(({ uuid, type, ...wanted }) => !services.some((service) =>
      service.uuid === uuid && matchesSetting(serviceSettings(service), wanted))))) mismatches.push("outgoing_services");
  if (args.remove_outgoing_services?.some((id) => services.some((service) => service.uuid === id))) mismatches.push("remove_outgoing_services");
  if (args.output_files) {
    const remaining = [...(saved?.output_files ?? [])];
    for (const wanted of args.output_files) {
      const index = remaining.findIndex((file) => matchesSetting(file, wanted));
      if (index < 0) { mismatches.push("output_files"); break; }
      remaining.splice(index, 1);
    }
    if (remaining.length && !mismatches.includes("output_files")) mismatches.push("output_files");
  }
  if (mismatches.length) throw new ToolError("PRODUCTION_UPDATE_UNCONFIRMED",
    "Auphonic n’a pas confirmé tous les réglages demandés.", { unconfirmed_fields: mismatches });
}

function productionChanges(args, current) {
  const path = productionPath(args.production_uuid);
  const steps = [];
  const post = (name, suffix, body) => steps.push({ name, path: path + suffix, method: "POST", body });
  const clear = (name, suffix) => steps.push({ name, path: path + suffix, method: "DELETE" });
  const { title, subtitle, summary, basename, algorithms, multi_input_files, output_files, speech_recognition,
    outgoing_services, remove_outgoing_services, review_before_publishing } = args;

  if (outgoing_services !== undefined && remove_outgoing_services !== undefined) {
    throw new UploadInputError("Utilisez outgoing_services pour remplacer la liste ou remove_outgoing_services pour retirer des destinations.");
  }
  if (algorithms) {
    const changes = algorithmPatch(algorithms);
    if (!Object.keys(changes).length) throw new UploadInputError("Les champs cutter et levelermode sont calculés par Auphonic. Indiquez les réglages éditables.");
    post("algorithms", "/algorithms.json", changes);
  }

  const trackIds = new Set();
  for (const update of multi_input_files ?? []) {
    if ([update.algorithms, update.offset, update.keep_offset].every((value) => value === undefined)) {
      throw new UploadInputError("Indiquez les réglages à modifier pour la piste " + update.id + ".");
    }
    const track = current.multi_input_files?.find((track) => track.type === "multitrack" && track.id === update.id);
    if (!track) throw new ToolError("TRACK_NOT_FOUND", "Piste multipiste introuvable : " + update.id, { next_action: "check_status" });
    if (trackIds.has(track.id)) throw new UploadInputError("Chaque piste ne peut être modifiée qu’une fois par appel.");
    trackIds.add(track.id);
    const changes = algorithmPatch(update.algorithms);
    if (update.algorithms && !Object.keys(changes).length) throw new UploadInputError("Indiquez les algorithmes éditables de la piste " + update.id + ".");
    post("multi_input_files:" + track.id, "/multi_input_files/" + encodeURIComponent(track.id) + ".json", {
      type: "multitrack", id: track.id,
      algorithms: update.algorithms ? { ...algorithmPatch(track.algorithms), ...changes } : undefined,
      // The track API resets timing fields when they are omitted.
      offset: update.offset ?? track.offset ?? 0, keep_offset: update.keep_offset ?? track.keep_offset ?? false,
    });
  }

  if (speech_recognition === null) {
    if (current.speech_recognition && Object.keys(current.speech_recognition).length) clear("speech_recognition", "/speech_recognition.json");
  } else if (speech_recognition !== undefined) {
    if (!speech_recognition.language.trim()) throw new UploadInputError("Indiquez une langue de transcription ou auto.");
    if (speech_recognition.uuid !== undefined) uuid(speech_recognition.uuid, "speech_recognition.uuid");
    post("speech_recognition", "/speech_recognition.json", speech_recognition);
  }

  let publicationChanged = false;
  if (outgoing_services !== undefined || remove_outgoing_services !== undefined) {
    const existing = new Map((current.outgoing_services ?? []).map((service) => [service.uuid, service]));
    const removed = new Set((remove_outgoing_services ?? []).map((id) => uuid(id, "remove_outgoing_services")));
    const wanted = outgoing_services ?? [...existing.keys()].filter((id) => !removed.has(id)).map((uuid) => ({ uuid }));
    const selected = new Set(wanted.map((service) => uuid(service.uuid, "outgoing_services.uuid")));
    if (selected.size !== wanted.length) throw new UploadInputError("Chaque destination doit avoir un UUID distinct.");
    const replaces = [...existing.keys()].some((id) => !selected.has(id));
    if (replaces) clear("outgoing_services", "/outgoing_services.json");
    const additions = wanted.filter((service) => replaces || !existing.has(service.uuid) || Object.keys(service).length > 1);
    if (additions.length) post("outgoing_services", "/outgoing_services.json",
      additions.map((service) => ({ ...serviceSettings(existing.get(service.uuid) ?? {}), ...service })));
    publicationChanged = replaces || additions.length > 0;
  }

  if (output_files !== undefined) {
    for (const file of output_files) {
      if (!file.format.trim()) throw new UploadInputError("Chaque sortie doit préciser son format Auphonic.");
      for (const service of file.outgoing_services ?? []) uuid(service, "output_files.outgoing_services");
    }
    // Changing transcription can create outputs. Apply the explicit output list afterward.
    if (current.output_files?.length || speech_recognition !== undefined) clear("output_files", "/output_files.json");
    if (output_files.length) post("output_files", "/output_files.json", output_files);
  }

  const review = review_before_publishing ?? (publicationChanged ? current.review_before_publishing : undefined);
  if ([title, subtitle, summary, basename, review].some((value) => value !== undefined)) {
    post("production_settings", ".json", {
      metadata: [title, subtitle, summary].some((value) => value !== undefined) ? { title, subtitle, summary } : undefined,
      output_basename: basename, review_before_publishing: review,
    });
  }
  return steps;
}

const draftSettings = ["algorithms", "multi_input_files", "output_files", "speech_recognition", "outgoing_services",
  "remove_outgoing_services", "review_before_publishing"];

tool("update_production", "Modifie les réglages d’un brouillon sans le démarrer ni le publier. Consultez check_status pour connaître ses réglages effectifs. Les listes output_files et outgoing_services, si fournies, définissent la liste finale.", {
  production_uuid: productionId, title: titleField, subtitle: text("Sous-titre"), summary: text("Résumé"),
  basename: text("Nom de base des fichiers de sortie"),
  algorithms: algorithmSettings({ ...trackAlgorithmFields, ...masterAlgorithmFields }, "Réglages du master ou de la production mono. En multipiste, réglez le filtrage et le débruitage dans multi_input_files."),
  multi_input_files: {
    type: "array", minItems: 1, description: "Réglages des pistes multipistes existantes. Utilisez les identifiants exacts renvoyés par check_status.",
    items: object({ id: text("Identifiant de la piste"), algorithms: algorithmSettings(trackAlgorithmFields, "Réglages Auphonic de cette piste."),
      offset: { ...number("Décalage en secondes"), minimum: 0 }, keep_offset: bool("Conserver le décalage lors de la synchronisation"),
    }, "Modifie les réglages d’une piste. Les autres pistes et le fichier associé sont conservés.", ["id"]),
  },
  output_files: { type: "array", items: object(outputFields, "Configuration d’une sortie Auphonic", ["format"]),
    description: "Liste finale des sorties. Omettez le champ pour les conserver et envoyez [] pour les retirer." },
  speech_recognition: { ...object(speechFields, "Configuration de transcription. Indiquez language, et uuid pour un moteur externe. null désactive la transcription.", ["language"]), type: ["object", "null"] },
  outgoing_services: { type: "array", items: object(serviceFields, "Configuration d’une destination de publication", ["uuid"]),
    description: "Liste finale des destinations. Omettez le champ pour les conserver et envoyez [] pour les retirer." },
  remove_outgoing_services: strings("UUID des destinations à retirer du brouillon. Conserve les autres destinations. Incompatible avec outgoing_services."),
  review_before_publishing: bool("Exiger une validation avant la publication vers les destinations configurées"),
}, ["production_uuid"], { ...write, destructiveHint: true }, async (args, env) => {
  const { production_uuid } = args;
  if (Object.keys(args).length < 2) throw new UploadInputError("Fournissez au moins un champ à modifier.");
  const path = productionPath(production_uuid) + ".json";
  const current = await api(env, path);
  if (current.change_allowed === false || (draftSettings.some((key) => Object.hasOwn(args, key)) && !uploadableStatuses.has(current.status))) {
    throw new ToolError("PRODUCTION_NOT_EDITABLE", "Ces réglages peuvent être modifiés sur un brouillon éditable.", {
      production_uuid, next_action: "check_status",
    });
  }
  const steps = productionChanges(args, current);
  const completed = [];
  try {
    for (const step of steps) {
      await api(env, step.path, { method: step.method, body: step.body });
      completed.push({ name: step.name, method: step.method });
    }
    const saved = steps.length ? await api(env, path) : current;
    verifyProductionChanges(args, saved);
    return productionDetails(saved, production_uuid, env);
  } catch (error) {
    const saved = await api(env, path).catch(() => null);
    throw new ToolError(error.code ?? "PRODUCTION_UPDATE_FAILED", error.message, {
      ...error.details, retryable: false, production_uuid, completed, next_action: "check_status",
      attempted: steps[completed.length]?.name,
      production: saved ? productionDetails(saved, production_uuid, env) : undefined,
    });
  }
});

tool("upload_production_file", "Envoie ou remplace une pièce jointe dans un brouillon Auphonic existant. En multipiste, indiquez le nom de la piste renvoyé par check_status. En mono, omettez track.", {
  production_uuid: productionId, file: attachment, track: text("Nom d’une piste multipiste existante"),
}, ["production_uuid", "file"], { ...write, destructiveHint: true }, async ({ production_uuid, file, track }, env) => {
  const path = productionPath(production_uuid);
  const draft = await api(env, path + ".json");
  const field = draftUploadField(draft, track);
  try {
    const source = await openAttachment(file);
    try {
      await sendAudio(env, path + "/upload.json", {}, [[field, source]]);
    } finally {
      await source.body.cancel().catch(() => {});
    }
    const saved = await api(env, path + ".json");
    if (!(draft.is_multitrack ? saved?.multi_input_files?.some((input) => input.id === field && input.input_file) : saved?.input_file)) {
      throw new ToolError("UPLOAD_UNCONFIRMED", "Auphonic n’a pas confirmé le fichier d’entrée.");
    }
    return { ...productionDetails(saved, production_uuid, env), uploaded_file: { track: track && field, file: source.name } };
  } catch (error) {
    throw await draftError(error, env, production_uuid);
  }
});
tools.upload_production_file._meta = { "openai/fileParams": ["file"] };

const prompts = {
  upload_and_process: { description: "Préparer un fichier audio pour Auphonic", message: "Consulte les préréglages et leurs réglages. Prépare un brouillon avec upload_audio, ou create_multitrack_from_files pour plusieurs pièces jointes." },
  analyze_production: { description: "Consulter une production", message: "Demande l’UUID de la production si nécessaire, puis consulte son statut avec check_status." },
  check_recent_uploads: { description: "Consulter les productions récentes", message: "Consulte les dernières productions avec list_productions et résume leur état." },
};
const resources = [
  { uri: "auphonic://config", name: "Configuration Auphonic", mimeType: "application/json" },
  { uri: "auphonic://presets", name: "Préréglages Auphonic", mimeType: "application/json" },
];
function jsonError(id, code, message) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function validateArgument(name, value, schema) {
  const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null && declared.includes("null")) return;
  const type = declared.find((type) => type !== "null");
  const valid = type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : type === "array" ? Array.isArray(value)
    : type === "integer" ? Number.isSafeInteger(value)
    : type === "number" ? Number.isFinite(value)
    : typeof value === type;
  if (!valid || (schema.enum && !schema.enum.includes(value)) || value < schema.minimum || value > schema.maximum) {
    throw new ToolError("INVALID_ARGUMENT", "Argument invalide : " + name);
  }
  if (type === "array") {
    if (value.length < schema.minItems || value.length > schema.maxItems) throw new ToolError("INVALID_ARGUMENT", "Nombre d’éléments invalide : " + name);
    value.forEach((item) => validateArgument(name, item, schema.items));
  }
  if (type !== "object") return;
  if (Object.keys(value).length < schema.minProperties) throw new ToolError("INVALID_ARGUMENT", "Précisez au moins un réglage : " + name);
  for (const field of schema.required ?? []) {
    if (!Object.hasOwn(value, field)) throw new ToolError("INVALID_ARGUMENT", "Argument requis : " + field);
  }
  for (const [key, item] of Object.entries(value)) {
    const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : schema.additionalProperties;
    if (property === false) throw new ToolError("INVALID_ARGUMENT", "Argument inconnu : " + key);
    if (property && property !== true) validateArgument(name + "." + key, item, property);
  }
}

async function mcp(request, env) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  let message;
  try { message = await request.json(); } catch { return jsonError(null, -32700, "Parse error"); }
  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") return jsonError(null, -32600, "Invalid request");
  const { id, method, params } = message;
  if (id === undefined) return new Response(null, { status: 202 });
  const ok = (result) => Response.json({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "server/discover": return ok({ supportedVersions: [version], serverInfo, capabilities });
    case "initialize": return ok({ protocolVersion: ["2025-03-26", "2025-06-18", "2025-11-25", version].includes(params?.protocolVersion) ? params.protocolVersion : "2025-03-26", serverInfo, capabilities });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: Object.values(tools).map(({ run, ...definition }) => definition) });
    case "tools/call": {
      const name = params?.name;
      if (!Object.hasOwn(tools, name)) return jsonError(id, -32602, "Unknown tool");
      const selected = tools[name];
      const args = params?.arguments ?? {};
      try {
        validateArgument("arguments", args, selected.inputSchema);
        const result = await selected.run(args, env, new URL(request.url).origin);
        return ok({ structuredContent: Array.isArray(result) ? { items: result } : result,
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (error) {
        const message = publicMessage(error.message, env);
        const { retryable = false, upstream_status, ...details } = error.details ?? {};
        return ok({ isError: true, structuredContent: { ...details, retryable,
          error: { code: error.code ?? "TOOL_ERROR", message, upstream_status } },
          content: [{ type: "text", text: message }] });
      }
    }
    case "resources/list": return ok({ resources });
    case "resources/templates/list": return ok({ resourceTemplates: [{ uriTemplate: "auphonic://production/{uuid}", name: "Production Auphonic", mimeType: "application/json" }] });
    case "resources/read": {
      const uri = params?.uri;
      try {
        let data;
        if (uri === "auphonic://config") data = {
          configured: Boolean(env.AUPHONIC_API_KEY?.trim()),
          shows: Object.keys(env).filter((key) => key.startsWith("AUPHONIC_PRESET_")).map((key) => key.slice("AUPHONIC_PRESET_".length).toLowerCase()),
        };
        else if (uri === "auphonic://presets") data = await tools.list_presets.run({}, env);
        else if (typeof uri === "string" && uri.startsWith("auphonic://production/")) {
          data = await tools.check_status.run({ production_uuid: uri.slice("auphonic://production/".length) }, env);
        } else return jsonError(id, -32002, "Resource not found");
        return ok({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data) }] });
      } catch (error) { return jsonError(id, -32000, error.message); }
    }
    case "prompts/list": return ok({ prompts: Object.entries(prompts).map(([name, { description }]) => ({ name, description })) });
    case "prompts/get": {
      const name = params?.name;
      if (!Object.hasOwn(prompts, name)) return jsonError(id, -32602, "Unknown prompt");
      return ok({ description: prompts[name].description, messages: [{ role: "user", content: { type: "text", text: prompts[name].message } }] });
    }
    default: return jsonError(id, -32601, "Method not found");
  }
}

const browserFileLimit = 90 * 1024 * 1024;
const attachmentLimit = 2 * 1024 * 1024 * 1024;
const fileTypes = /\.(?:wav|bwf|rf64|w64|flac|mp[234]|m4[abv]|ogg|oga|opus|aac|aiff?|aifc|caf|wma|webm|mov|mkv|mpeg|mpg|avi|ac3|alac|mxf)$/i;
const encode = new TextEncoder();

class UploadInputError extends ToolError {
  constructor(message, status = 400, code = "INVALID_ARGUMENT") {
    super(code, message);
    this.status = status;
  }
}

function audioName(value, mime = "") {
  let name = value?.split(/[\\/]/).at(-1).trim();
  if (!name && mime.startsWith("audio/")) name = "audio." + (mime === "audio/mpeg" ? "mp3" : mime.split("/")[1]);
  if (!name || !fileTypes.test(name) || name.length > 240 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new UploadInputError("Indiquez un fichier audio ou vidéo pris en charge (WAV, FLAC, MP3, M4A, OGG, OPUS, MP4…).");
  }
  return name;
}

function audioSize(value, maximum) {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1) throw new UploadInputError("Taille du fichier indisponible ou fichier vide.");
  if (size > maximum) throw new UploadInputError("Fichier trop volumineux. Limite : " + maximum / (1024 * 1024) + " Mio.", 413);
  return size;
}

function resolveAttachment(file) {
  let url;
  try { url = new URL(file.download_url); } catch { throw new UploadInputError("URL de pièce jointe invalide."); }
  const allowed = /(?:^|\.)(?:oaiusercontent\.com|oaistatic\.com|chatgpt\.com)$/.test(url.hostname) ||
    /^(?:oai[a-z0-9]*|sdmnt[a-z0-9]*)\.blob\.core\.windows\.net$/.test(url.hostname) ||
    /^(?:oai[a-z0-9-]*|sdmnt[a-z0-9-]*)\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname);
  if (url.protocol !== "https:" || !allowed || url.username || url.password || url.port) {
    throw new UploadInputError("Utilisez une pièce jointe ChatGPT ou le champ input_url pour une URL externe.");
  }
  const name = file.file_name ? audioName(file.file_name) : undefined;
  return { url, name, mime: file.mime_type, label: name ?? file.file_id };
}

function openAttachment(file) {
  return downloadAttachment(resolveAttachment(file));
}

async function downloadAttachment({ url, name, mime }) {
  const inaccessible = () => new UploadInputError("Pièce jointe inaccessible. Joignez-la de nouveau ou utilisez le formulaire du site.", 400, "ATTACHMENT_UNAVAILABLE");
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5 * 60 * 1000) }).catch(() => { throw inaccessible(); });
  try {
    if (!response.ok || !response.body) throw inaccessible();
    const size = audioSize(response.headers.get("content-length"), attachmentLimit);
    const disposition = response.headers.get("content-disposition") ?? "";
    const headerName = /;\s*filename=(?:"([^"]+)"|([^;]+))/i.exec(disposition);
    const media = response.headers.get("content-type")?.split(";")[0];
    return { name: name ?? audioName(headerName?.[1] ?? headerName?.[2], mime || media), size, body: response.body };
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
}

function multipartAudio(fields, files) {
  const boundary = "auphonic-" + crypto.randomUUID();
  const quoted = (value) => value.replaceAll('"', "%22").replaceAll("\r", "").replaceAll("\n", "").replaceAll("\\", "%5C");
  const metadata = Object.entries(fields).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) =>
    "--" + boundary + '\r\nContent-Disposition: form-data; name="' + key + '"\r\n\r\n' + value + "\r\n").join("");
  const parts = [new Blob([metadata]).stream()];
  let size = encode.encode(metadata).length;
  for (const [fieldName, source] of files) {
    const header = new Blob(["--" + boundary + '\r\nContent-Disposition: form-data; name="' +
      quoted(fieldName) + '"; filename="' + quoted(source.name) + '"\r\nContent-Type: application/octet-stream\r\n\r\n']);
    parts.push(header.stream(), source.body, new Blob(["\r\n"]).stream());
    size += header.size + source.size + 2;
  }
  const footer = new Blob(["--" + boundary + "--\r\n"]);
  parts.push(footer.stream());
  size += footer.size;
  let reader;
  const joined = new ReadableStream({
    async pull(controller) {
      while (reader || parts.length) {
        reader ??= parts.shift().getReader();
        const { value, done } = await reader.read();
        if (!done) {
          controller.enqueue(value);
          return;
        }
        reader.releaseLock();
        reader = undefined;
      }
      controller.close();
    },
    async cancel(reason) {
      await Promise.allSettled([reader?.cancel(reason), ...parts.map((part) => part.cancel(reason))]);
    },
  });
  const fixed = typeof FixedLengthStream === "function" ? new FixedLengthStream(size) : null;
  return { body: fixed ? joined.pipeThrough(fixed) : joined, contentType: "multipart/form-data; boundary=" + boundary };
}

function sendAudio(env, path, fields, files) {
  return api(env, path, {
    method: "POST", multipart: multipartAudio(fields, files), timeout: 5 * 60 * 1000,
  });
}

async function uploadSingle(env, { preset, title, subtitle, summary, type, mode = "save" }, source) {
  const data = await sendAudio(env, "/simple/productions.json", {
    preset, title, subtitle, summary, tags: type, action: mode,
  }, [["input_file", source]]);
  return productionDetails(data, uuid(data?.uuid, "UUID de la production créée"), env);
}

const maxTracks = 8;
// Auphonic may report an empty, incomplete, uploading, or saved draft.
const uploadableStatuses = new Set([0, 9, 10, 98]);
function hasRequiredInputs(data) {
  if (!data?.is_multitrack) return Boolean(data?.input_file);
  const tracks = (data.multi_input_files ?? []).filter((track) => track.type === "multitrack");
  return tracks.length > 0 && tracks.every((track) => track.input_file);
}

function draftUploadField(data, track) {
  if (data?.change_allowed === false || !uploadableStatuses.has(data?.status)) {
    throw new ToolError("PRODUCTION_NOT_EDITABLE", "L’upload est réservé aux brouillons modifiables.", { next_action: "check_status" });
  }
  if (!data.is_multitrack) {
    if (track !== undefined) throw new UploadInputError("Omettez track pour une production mono.");
    return "input_file";
  }
  const name = trackName(track);
  const input = data.multi_input_files?.find((input) => input.type === "multitrack" && input.id?.toLowerCase() === name.toLowerCase());
  if (!input) throw new ToolError("TRACK_NOT_FOUND", "Piste introuvable dans le brouillon.", { next_action: "check_status" });
  return input.id;
}

async function draftError(error, env, id, expected = []) {
  const data = await api(env, productionPath(id) + ".json").catch(() => null);
  const details = data ? productionDetails(data, id, env) : undefined;
  const inputs = (details?.tracks ?? []).filter((track) => track.type === "multitrack");
  const expectedNames = expected.length ? expected : inputs.map((track) => track.id);
  const missing = data ? expectedNames.filter((name) => !inputs.some((track) => track.id === name && track.has_input)) : undefined;
  const next = inputs.some((track) => missing?.includes(track.id)) || (data?.is_multitrack === false && !data.input_file)
    ? "upload_production_file" : "check_status";
  return new ToolError(error.code ?? "PRODUCTION_INCOMPLETE",
    "Brouillon " + id + ". " + publicMessage(error.message, env) + " Vérifiez son état avant de répéter une écriture.", {
      ...error.details, retryable: false, production_uuid: id, production: details, missing_tracks: missing, next_action: next,
    });
}

function trackName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 100 || /[\x00-\x1f\x7f"\\]/.test(name)) {
    throw new UploadInputError("Indiquez un nom valide pour chaque piste.");
  }
  return name;
}

async function planUploadDraft(env, { preset, title, basename, names }) {
  if (!Array.isArray(names) || names.length < 2 || names.length > maxTracks) {
    throw new UploadInputError("Sélectionnez entre 2 et 8 pistes pour le multipiste.");
  }
  const ids = names.map(trackName);
  if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
    throw new UploadInputError("Chaque piste doit avoir un nom distinct.");
  }
  const config = await api(env, "/preset/" + preset + ".json");
  if (config?.is_multitrack === false) throw new UploadInputError("Sélectionnez un préréglage multipiste.");
  const existing = (config?.multi_input_files ?? []).filter((track) => track.type === "multitrack" && track.id);
  const byId = new Map(existing.map((track) => [track.id.toLowerCase(), track]));
  const template = existing.find((track) => track.algorithms && Object.keys(track.algorithms).length)?.algorithms;
  const tracks = ids.map((id) => byId.get(id.toLowerCase())?.id ?? id);
  const wanted = new Set(tracks);
  const append = tracks.filter((id) => !byId.has(id.toLowerCase())).map((id) => ({ id, type: "multitrack", algorithms: template }));
  const drop = existing.filter((track) => !wanted.has(track.id)).map((track) => track.id);
  const body = { preset, is_multitrack: true, metadata: title ? { title } : undefined, output_basename: basename };
  if (!existing.length) body.multi_input_files = append;
  const newTracks = new Map(append.map((track) => [track.id, track]));
  return { body, tracks, drop, append: existing.length ? append : [], preset: presetDetails(config, preset),
    track_settings: tracks.map((id) => trackDetails(byId.get(id.toLowerCase()) ?? newTracks.get(id))) };
}

function uploadedTracks(production, expected, requireFiles = false) {
  const tracks = (production?.multi_input_files ?? []).filter((track) => track.type === "multitrack");
  const ids = new Set(tracks.map((track) => track.id));
  return tracks.length === expected.length && ids.size === expected.length &&
    expected.every((id) => ids.has(id)) && (!requireFiles || tracks.every((track) => track.input_file));
}

async function createUploadDraft(env, plan) {
  const { body, tracks, drop, append } = plan;
  const draft = await api(env, "/productions.json", { method: "POST", body });
  const id = uuid(draft?.uuid, "UUID de la production créée");
  const path = productionPath(id);
  try {
    for (const id of drop) {
      await api(env, path + "/multi_input_files/" + encodeURIComponent(id) + ".json", { method: "DELETE" });
    }
    if (append.length) {
      await api(env, path + ".json", { method: "POST", body: { multi_input_files: append } });
    }
    const saved = await api(env, path + ".json");
    if (!uploadedTracks(saved, tracks)) {
      throw Error("Auphonic a enregistré une liste de pistes différente.");
    }
    return { ...productionDetails(saved, id, env), upload_tracks: tracks };
  } catch (error) {
    throw await draftError(error, env, id, tracks);
  }
}

async function uploadMultitrack(env, args, preset, mode) {
  if (args.tracks !== undefined || args.service !== undefined || args.episode !== undefined) {
    throw new UploadInputError("Utilisez files et track_names ensemble pour un téléversement local.");
  }
  if (args.files.length !== args.track_names?.length) {
    throw new UploadInputError("Indiquez exactement un nom de piste par pièce jointe.");
  }
  const skip = new Set((args.skip_tracks ?? []).map((name) => name.trim().toLowerCase()));
  const entries = args.track_names.map((name, i) => [trackName(name), args.files[i]])
    .filter(([name]) => !skip.has(name.toLowerCase()));
  const files = entries.map(([, file]) => resolveAttachment(file));
  if (new Set(entries.map(([, file]) => file.file_id)).size !== entries.length) {
    throw new UploadInputError("Chaque piste doit utiliser une pièce jointe distincte.");
  }
  const plan = await planUploadDraft(env, { preset, title: args.title, basename: args.basename, names: entries.map(([name]) => name) });
  const mapping = plan.tracks.map((track, i) => ({ track, file: files[i].label }));
  if (preview(args.dry_run)) return {
    dry_run: true, preset, tracks: mapping, drop: plan.drop, track_settings: plan.track_settings,
    preset_settings: plan.preset, start: mode === "start",
  };

  const draft = await createUploadDraft(env, plan);
  const path = productionPath(draft.uuid);
  try {
    // Two files fit in the same multipart request while keeping the number of
    // open attachment streams bounded for setups with more tracks.
    for (let index = 0; index < files.length; index += 2) {
      const sources = [];
      try {
        for (const file of files.slice(index, index + 2)) {
          const position = index + sources.length;
          const source = await downloadAttachment(file);
          sources.push([plan.tracks[position], source]);
          mapping[position].file = source.name;
        }
        await sendAudio(env, path + "/upload.json", {}, sources);
      } finally {
        await Promise.allSettled(sources.map(([, source]) => source.body.cancel()));
      }
    }
    const saved = await api(env, path + ".json");
    if (!uploadedTracks(saved, plan.tracks, true)) throw Error("Auphonic n’a pas confirmé le fichier de chaque piste.");
    const result = mode === "start" ? await tools.start_production.run({ production_uuid: draft.uuid }, env) : productionDetails(saved, draft.uuid, env);
    return { ...result, uploaded_files: mapping };
  } catch (error) {
    throw await draftError(error, env, draft.uuid, plan.tracks);
  }
}

async function uploadRoute(request, url, env) {
  const path = url.pathname;
  const method = path === "/api/upload/presets" ? "GET" : "POST";
  if (request.method !== method) return new Response(null, { status: 405, headers: { Allow: method } });
  if (!request.headers.get("oai-authenticated-user-id")) return Response.json({ error: "Connectez-vous au site." }, { status: 401 });
  if (method === "POST" && request.headers.get("Origin") !== url.origin) {
    return Response.json({ error: "Ouvrez le formulaire sur le site Auphonic MCP." }, { status: 403 });
  }
  try {
    if (path === "/api/upload/presets") {
      const presets = records(await api(env, "/presets.json"));
      return Response.json(presets.map(({ uuid, preset_name, is_multitrack }) => ({ uuid, preset_name, is_multitrack })));
    }
    if (path === "/api/upload/draft") {
      if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw new UploadInputError("Requête JSON attendue.");
      const payload = await request.json().catch(() => null);
      if (!payload || typeof payload.preset !== "string" || typeof payload.title !== "string" || payload.title.length > 200) {
        throw new UploadInputError("Indiquez un préréglage et un titre valide.");
      }
      const plan = await planUploadDraft(env, { ...payload, preset: presetFor(payload, env) });
      return Response.json(await createUploadDraft(env, plan));
    }
    if (request.headers.get("Content-Type") !== "application/octet-stream" || !request.body) {
      throw new UploadInputError("Aucun fichier audio reçu.");
    }
    const name = audioName(url.searchParams.get("name"));
    const size = audioSize(request.headers.get("Content-Length") ?? request.headers.get("X-Audio-Size"), browserFileLimit);
    const source = { name, size, body: request.body };
    if (path === "/api/upload/single") {
      const preset = presetFor({ preset: url.searchParams.get("preset") }, env);
      const title = url.searchParams.get("title")?.trim() || name.replace(/\.[^.]+$/, "");
      if (title.length > 200) throw new UploadInputError("Le titre doit faire au plus 200 caractères.");
      return Response.json(await uploadSingle(env, { preset, title }, source));
    }
    const id = url.searchParams.get("production");
    const production = productionPath(id);
    const track = trackName(url.searchParams.get("track"));
    const draft = await api(env, production + ".json");
    if (!uploadableStatuses.has(draft?.status) || !draft.multi_input_files?.some((input) => input.type === "multitrack" && input.id === track)) {
      throw new UploadInputError("La piste est introuvable dans un brouillon multipiste modifiable.");
    }
    await sendAudio(env, production + "/upload.json", {}, [[track, source]]);
    return Response.json({ track, uuid: id, url: productionUrl(id) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status ?? 502, headers: { "Cache-Control": "no-store" } });
  }
}

const uploadPaths = new Set(["/api/upload/presets", "/api/upload/draft", "/api/upload/single", "/api/upload/track"]);

function resultFileUrl(data, id, filename) {
  if (!filename) return null;
  const file = data?.output_files?.find((file) => file.filename === filename && file.download_url);
  if (!file) return null;
  try {
    const url = new URL(file.download_url);
    if (url.origin === "https://auphonic.com" && !url.username && !url.password &&
      url.pathname.startsWith("/api/download/audio-result/" + id + "/")) return url;
  } catch {
    return null;
  }
  return null;
}

async function downloadRoute(request, url, env) {
  const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
  if (!request.headers.get("oai-authenticated-user-id")) return new Response("Connectez-vous au site.", { status: 401, headers });
  const id = url.searchParams.get("production");
  const filename = url.searchParams.get("filename");
  if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !filename) return new Response("Sélection de fichier invalide.", { status: 400, headers });
  try {
    const data = await api(env, productionPath(id) + ".json");
    const upstream = data?.status === 3 ? resultFileUrl(data, id, filename) : null;
    if (!upstream) return new Response("Fichier indisponible.", { status: 404, headers });
    const key = env.AUPHONIC_API_KEY.trim();
    upstream.searchParams.set("bearer_token", key);
    let target = upstream;
    const signal = AbortSignal.timeout(5 * 60 * 1000);
    for (let redirect = 0; redirect < 5; redirect++) {
      const audio = await fetch(target, { redirect: "manual", signal });
      if (audio.ok && audio.body) {
        const encodedName = encodeURIComponent(filename).replace(/['()*]/g, (char) => "%" + char.charCodeAt(0).toString(16));
        const length = audio.headers.get("Content-Length");
        return new Response(audio.body, { headers: {
          ...headers, "Content-Type": "application/octet-stream",
          "Content-Disposition": "attachment; filename*=UTF-8''" + encodedName,
          ...(length ? { "Content-Length": length } : {}),
        } });
      }
      await audio.body?.cancel().catch(() => {});
      const location = audio.headers.get("Location");
      if (![301, 302, 303, 307, 308].includes(audio.status) || !location) break;
      target = new URL(location, target);
      if (target.protocol !== "https:" || target.username || target.password || target.port) break;
      if (target.origin !== upstream.origin && decodeURIComponent(target.href).includes(key)) break;
    }
  } catch (error) {
    if (error.code === "NOT_FOUND") return new Response("Fichier indisponible.", { status: 404, headers });
  }
  return new Response("Auphonic n’a pas pu fournir le fichier.", { status: 502, headers });
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === "/mcp") return mcp(request, env);
    if (pathname === "/api/output") return downloadRoute(request, url, env);
    if (pathname === "/health") return Response.json({ status: "ok", auphonic_configured: Boolean(env.AUPHONIC_API_KEY?.trim()) });
    if (uploadPaths.has(pathname)) return uploadRoute(request, url, env);
    if (pathname !== "/") return new Response("Introuvable", { status: 404 });
    return new Response(uploadPage, { headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    } });
  },
};

const uploadPage = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auphonic MCP · Téléverser</title>
<style>
:root{color-scheme:light;font:1rem/1.5 system-ui,sans-serif;background:#f2f8f6;color:#173130}
body{margin:0;padding:clamp(1.25rem,6vw,4rem) 1rem}
main{max-width:42rem;margin:auto}
h1{font-size:clamp(2rem,5vw,3rem);letter-spacing:-.055em;margin:0}
header p{margin:.35rem 0 1.75rem;color:#455f5b}
form{display:grid;gap:1.2rem;border:1px solid #d0e2df;border-radius:1rem;background:white;padding:clamp(1rem,4vw,2rem)}
label{display:grid;gap:.35rem;font-weight:650}
input,select,button{font:inherit}
input,select{box-sizing:border-box;width:100%;min-width:0;border:1px solid #9bb6b2;border-radius:.45rem;padding:.6rem .75rem;background:#fff;color:inherit}
input[type=file]{border-style:dashed;padding:1rem}
button{justify-self:start;border:0;border-radius:.5rem;background:#006659;color:white;font-weight:700;padding:.65rem 1rem;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
a{color:#006659}
small,footer{color:#455f5b}
p,ul{margin:0}
fieldset{min-width:0;margin:0;padding:.65rem 0 0;border:0}
legend{padding:0;font-weight:650}
#tracks{display:grid;gap:.7rem}
#tracks small{overflow-wrap:anywhere}
[hidden]{display:none!important}
progress{width:100%;accent-color:#006659}
#status[data-error=true]{color:#922c22}
footer{margin-top:1.2rem;font-size:.9rem}
</style>
</head>
<body>
<main>
<header><h1>Auphonic MCP</h1><p>Déposez votre mix ou les pistes de votre épisode dans un brouillon Auphonic.</p></header>
<form id="upload">
<label>Préréglage <select id="preset" required disabled><option value="">Chargement…</option></select></label>
<label>Titre de l’épisode <input id="title" name="title" maxlength="200" placeholder="Facultatif"></label>
<label>Fichiers audio <input id="files" type="file" accept="audio/*,video/*,.wav,.flac,.mp3,.m4a,.ogg,.opus,.bwf,.rf64,.w64" multiple required>
<small>Un fichier pour un mix, de 2 à 8 pour une production multipiste. 90 Mio maximum par fichier.</small></label>
<fieldset id="track-fields" hidden><legend>Noms des pistes</legend><div id="tracks"></div></fieldset>
<button id="submit" disabled>Créer le brouillon</button>
<progress id="progress" max="100" value="0" aria-label="Progression du téléversement" hidden></progress>
<p id="status" role="status" aria-live="polite"></p>
<a id="production" hidden target="_blank" rel="noopener">Ouvrir le brouillon dans Auphonic</a>
</form>
<footer><a href="https://auphonic.com/account">Compte Auphonic</a> · <a href="https://github.com/JupiterBroadcasting/auphonic-mcp">Code d’origine</a></footer>
</main>
<script>
const form = document.getElementById("upload");
const preset = document.getElementById("preset");
const title = document.getElementById("title");
const files = document.getElementById("files");
const trackFields = document.getElementById("track-fields");
const tracks = document.getElementById("tracks");
const button = document.getElementById("submit");
const progress = document.getElementById("progress");
const status = document.getElementById("status");
const production = document.getElementById("production");
const inputs = [preset, title, files, trackFields];
let draft;
let nextTrack = 0;

function show(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw Error(data?.error || "Le site a répondu avec le statut " + response.status + ".");
  return data;
}

function setLink(url) {
  production.href = url;
  production.hidden = false;
}

function sendFile(path, params, file, onProgress) {
  const query = new URLSearchParams({ ...params, name: file.name });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path + "?" + query);
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Audio-Size", String(file.size));
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) resolve(xhr.response);
      else reject(Error(xhr.response?.error || (xhr.status === 413 ? "Fichier trop volumineux." : "Le site a répondu avec le statut " + xhr.status + ".")));
    };
    xhr.onerror = () => reject(Error("Connexion interrompue pendant le téléversement."));
    xhr.send(file);
  });
}

function resetDraft() {
  draft = undefined;
  nextTrack = 0;
  production.hidden = true;
  button.textContent = "Créer le brouillon";
  progress.hidden = true;
  show("");
}

files.addEventListener("change", () => {
  resetDraft();
  const list = Array.from(files.files);
  trackFields.hidden = list.length < 2;
  tracks.replaceChildren(...list.slice(0, 8).map((file) => {
    const label = document.createElement("label");
    const hint = document.createElement("small");
    const name = document.createElement("input");
    hint.textContent = file.name;
    name.value = file.name.replace(/\\.[^.]+$/, "").slice(0, 100);
    name.maxLength = 100;
    name.required = list.length > 1;
    label.append(hint, name);
    return label;
  }));
});
form.addEventListener("input", (event) => {
  if (event.target !== files && draft) resetDraft();
});

api("/api/upload/presets").then((data) => {
  preset.replaceChildren(new Option("Choisir un préréglage", ""));
  for (const item of data) {
    const suffix = item.is_multitrack === true ? " · multipiste" : "";
    preset.append(new Option(item.preset_name + suffix, item.uuid));
  }
  preset.disabled = false;
  button.disabled = data.length === 0;
  if (!data.length) show("Aucun préréglage disponible sur le compte Auphonic.", true);
}).catch((error) => show(error.message, true));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  const list = Array.from(files.files);
  if (list.length < 1 || list.length > 8) return show("Sélectionnez de 1 à 8 fichiers.", true);
  const badFile = list.find((file) => file.size < 1 || file.size > ${browserFileLimit});
  if (badFile) return show("Fichier vide ou supérieur à 90 Mio : " + badFile.name, true);
  const names = Array.from(tracks.querySelectorAll("input"), (input) => input.value.trim());
  const selectedPreset = preset.value;
  const episode = title.value.trim();
  button.disabled = true;
  inputs.forEach((input) => { input.disabled = true; });
  progress.hidden = false;
  progress.value = (nextTrack / list.length) * 100;
  try {
    if (list.length === 1) {
      show("Téléversement du fichier…");
      const result = await sendFile("/api/upload/single", { preset: selectedPreset, title: episode }, list[0],
        (fraction) => { progress.value = fraction * 100; });
      setLink(result.url);
    } else {
      if (!draft) {
        show("Création du brouillon multipiste…");
        draft = await api("/api/upload/draft", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preset: selectedPreset, title: episode, names }) });
        setLink(draft.url);
      }
      for (; nextTrack < list.length; nextTrack += 1) {
        const track = draft.upload_tracks[nextTrack];
        show("Téléversement de la piste " + (nextTrack + 1) + " sur " + list.length + " · " + track);
        await sendFile("/api/upload/track", { production: draft.uuid, track }, list[nextTrack],
          (fraction) => { progress.value = ((nextTrack + fraction) / list.length) * 100; });
      }
    }
    show("Brouillon enregistré dans Auphonic. Vous pouvez le vérifier et lancer le traitement quand vous êtes prêt.");
    progress.value = 100;
    form.reset();
    trackFields.hidden = true;
    tracks.replaceChildren();
    draft = undefined;
    nextTrack = 0;
    button.textContent = "Créer le brouillon";
  } catch (error) {
    show(error.message, true);
    if (draft) button.textContent = "Reprendre le téléversement";
  } finally {
    button.disabled = false;
    inputs.forEach((input) => { input.disabled = false; });
  }
});
</script>
</body></html>`;
