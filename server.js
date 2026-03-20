const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = __dirname;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8'
};

const motsFrancais = [
    'chat', 'chien', 'maison', 'voiture', 'pain', 'eau', 'livre', 'arbre', 'soleil', 'lune',
    'porte', 'table', 'fleur', 'route', 'montagne', 'mer', 'pomme', 'banane', 'fromage', 'cle',
    'fenetre', 'chaise', 'camion', 'bus', 'train', 'avion', 'plage', 'foret', 'rue', 'ville',
    'ordinateur', 'musique', 'film', 'photo', 'journal', 'stylo', 'papier', 'crayon', 'bouteille', 'verre',
    'telephone', 'lampe', 'couteau', 'fourchette', 'cuillere', 'assiette', 'serviette', 'chaussure', 'veste', 'pantalon'
];

const sessions = new Map();

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function sendError(res, statusCode, message) {
    sendJson(res, statusCode, { error: message });
}

function normalizePlayerName(value) {
    return String(value || '').trim().substring(0, 12);
}

function normalizeBooleanSetting(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['0', 'false', 'off', 'no'].includes(normalized)) {
        return false;
    }
    if (['1', 'true', 'on', 'yes'].includes(normalized)) {
        return true;
    }

    return Boolean(value);
}

function normalizeSettings(settings = {}, fallback = { players: 5, mrWhite: true, undercover: true }) {
    const players = Math.min(20, Math.max(3, Number(settings.players) || fallback.players));
    return {
        players,
        mrWhite: normalizeBooleanSetting(settings.mrWhite, fallback.mrWhite),
        undercover: normalizeBooleanSetting(settings.undercover, fallback.undercover)
    };
}

function randomCode() {
    let code = '';
    do {
        code = Math.random().toString(36).substring(2, 8).toUpperCase();
    } while (sessions.has(code));
    return code;
}

function randomPlayerId() {
    return crypto.randomUUID();
}

function shuffle(array) {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function updateSessionRevision(session) {
    session.revision += 1;
    session.updatedAt = Date.now();
}

function pickDistinctWords() {
    const motCivil = motsFrancais[Math.floor(Math.random() * motsFrancais.length)];
    let motUndercover = motCivil;

    while (motUndercover === motCivil) {
        motUndercover = motsFrancais[Math.floor(Math.random() * motsFrancais.length)];
    }

    return { motCivil, motUndercover };
}

function buildAssignments(session) {
    const { motCivil, motUndercover } = pickDistinctWords();
    const roles = [];
    const nbMrWhite = session.settings.mrWhite ? 1 : 0;
    const nbUndercover = session.settings.undercover ? 1 : 0;
    const nbCivils = session.players.length - nbMrWhite - nbUndercover;

    for (let i = 0; i < nbCivils; i += 1) {
        roles.push({ role: 'civil', word: motCivil });
    }
    if (nbUndercover) {
        roles.push({ role: 'undercover', word: motUndercover });
    }
    if (nbMrWhite) {
        roles.push({ role: 'mrwhite', word: null });
    }

    const shuffledRoles = shuffle(roles);
    session.assignments = {};
    session.players.forEach((player, index) => {
        session.assignments[player.id] = shuffledRoles[index];
    });
}

function buildSessionView(session, playerId) {
    const player = session.players.find((entry) => entry.id === playerId);
    const host = session.players.find((entry) => entry.id === session.hostPlayerId);
    const assignment = session.assignments ? session.assignments[playerId] : null;
    const activePlayer = session.status === 'clues' ? session.players[session.activeClueIndex] : null;
    const acknowledgedSet = session.secretAcknowledged || new Set();

    return {
        code: session.code,
        revision: session.revision,
        status: session.status,
        isHost: session.hostPlayerId === playerId,
        self: player ? { id: player.id, name: player.name } : null,
        hostName: host ? host.name : 'Hote',
        settings: session.settings,
        playerCount: session.players.length,
        canStart: session.status === 'waiting'
            && session.hostPlayerId === playerId
            && session.players.length === session.settings.players,
        players: session.players.map((entry) => ({
            id: entry.id,
            name: entry.name,
            isHost: entry.id === session.hostPlayerId,
            acknowledged: acknowledgedSet.has(entry.id),
            clueSubmitted: session.clues.some((clue) => clue.playerId === entry.id)
        })),
        secret: assignment ? {
            role: assignment.role,
            word: assignment.word,
            acknowledged: acknowledgedSet.has(playerId)
        } : null,
        acknowledgedCount: acknowledgedSet.size,
        allSecretsAcknowledged: acknowledgedSet.size === session.players.length && session.players.length > 0,
        activePlayerId: activePlayer ? activePlayer.id : null,
        activePlayerName: activePlayer ? activePlayer.name : null,
        yourTurn: activePlayer ? activePlayer.id === playerId : false,
        clues: session.clues.map((clue) => ({
            playerId: clue.playerId,
            playerName: session.players.find((entry) => entry.id === clue.playerId)?.name || 'Joueur',
            text: clue.text
        })),
        submittedCount: session.clues.length,
        totalTurns: session.players.length
    };
}

async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 1_000_000) {
                reject(new Error('Payload trop volumineux.'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!data) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(data));
            } catch (error) {
                reject(new Error('Le JSON envoye est invalide.'));
            }
        });
        req.on('error', reject);
    });
}

function serveStaticFile(req, res, pathname) {
    const requestedPath = pathname === '/' ? '/index.html' : pathname;
    const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(ROOT_DIR, normalizedPath);

    if (!filePath.startsWith(ROOT_DIR)) {
        sendError(res, 403, 'Acces refuse.');
        return;
    }

    fs.stat(filePath, (statError, stats) => {
        if (statError || !stats.isFile()) {
            sendError(res, 404, 'Fichier introuvable.');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
    });
}

function ensureSession(sessionCode) {
    return sessions.get(String(sessionCode || '').trim().toUpperCase());
}

function ensurePlayer(session, playerId) {
    return session.players.find((entry) => entry.id === playerId);
}

async function handleApiRequest(req, res, pathname, searchParams) {
    if (req.method === 'POST' && pathname === '/api/session/create') {
        const body = await readJsonBody(req);
        const playerName = normalizePlayerName(body.playerName);
        if (!playerName) {
            sendError(res, 400, 'Entre un pseudo avant de creer la session.');
            return;
        }

        const code = randomCode();
        const hostPlayerId = randomPlayerId();
        const settings = normalizeSettings(body.settings || {});
        const session = {
            code,
            hostPlayerId,
            players: [{ id: hostPlayerId, name: playerName }],
            settings,
            status: 'waiting',
            revision: 1,
            assignments: null,
            secretAcknowledged: new Set(),
            clues: [],
            activeClueIndex: 0,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        sessions.set(code, session);
        sendJson(res, 201, {
            code,
            playerId: hostPlayerId,
            playerName
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/session/join') {
        const body = await readJsonBody(req);
        const code = String(body.code || '').trim().toUpperCase();
        const playerName = normalizePlayerName(body.playerName);
        const requestedPlayerId = String(body.playerId || '').trim();
        const session = ensureSession(code);

        if (!session) {
            sendError(res, 404, 'Cette session est introuvable.');
            return;
        }

        if (session.status !== 'waiting') {
            sendError(res, 400, 'La partie a deja commence.');
            return;
        }

        if (!playerName) {
            sendError(res, 400, 'Entre un pseudo avant de rejoindre la session.');
            return;
        }

        if (requestedPlayerId) {
            const existingById = ensurePlayer(session, requestedPlayerId);
            if (existingById) {
                sendJson(res, 200, {
                    code,
                    playerId: existingById.id,
                    playerName: existingById.name
                });
                return;
            }
        }

        const existingByName = session.players.find((entry) => entry.name.toLowerCase() === playerName.toLowerCase());
        if (existingByName) {
            sendError(res, 400, 'Ce pseudo est deja utilise dans la session.');
            return;
        }

        if (session.players.length >= session.settings.players) {
            sendError(res, 400, 'Ce salon est actuellement complet.');
            return;
        }

        const playerId = randomPlayerId();
        session.players.push({ id: playerId, name: playerName });
        updateSessionRevision(session);
        sendJson(res, 201, {
            code,
            playerId,
            playerName
        });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/session/state') {
        const code = searchParams.get('code');
        const playerId = searchParams.get('playerId');
        const session = ensureSession(code);

        if (!session) {
            sendError(res, 404, 'Cette session est introuvable.');
            return;
        }

        if (!ensurePlayer(session, playerId)) {
            sendError(res, 403, 'Cette session ne reconnait pas ce joueur.');
            return;
        }

        sendJson(res, 200, buildSessionView(session, playerId));
        return;
    }

    if (req.method === 'POST' && pathname === '/api/session/settings') {
        const body = await readJsonBody(req);
        const session = ensureSession(body.code);
        if (!session) {
            sendError(res, 404, 'Cette session est introuvable.');
            return;
        }

        const player = ensurePlayer(session, body.playerId);
        if (!player) {
            sendError(res, 403, 'Joueur non reconnu pour cette session.');
            return;
        }

        if (session.hostPlayerId !== player.id) {
            sendError(res, 403, "Seul l'hote peut modifier les parametres.");
            return;
        }

        if (session.status !== 'waiting') {
            sendError(res, 400, 'La partie a deja commence.');
            return;
        }

        const nextSettings = normalizeSettings(body.settings || {}, session.settings);
        if (nextSettings.players < session.players.length) {
            sendError(res, 400, 'Le nombre de joueurs ne peut pas etre inferieur au nombre de joueurs deja connectes.');
            return;
        }

        session.settings = nextSettings;
        updateSessionRevision(session);
        sendJson(res, 200, buildSessionView(session, player.id));
        return;
    }

    if (req.method === 'POST' && pathname === '/api/session/start') {
        const body = await readJsonBody(req);
        const session = ensureSession(body.code);
        if (!session) {
            sendError(res, 404, 'Cette session est introuvable.');
            return;
        }

        const player = ensurePlayer(session, body.playerId);
        if (!player) {
            sendError(res, 403, 'Joueur non reconnu pour cette session.');
            return;
        }

        if (session.hostPlayerId !== player.id) {
            sendError(res, 403, "Seul l'hote peut lancer la partie.");
            return;
        }

        if (session.players.length !== session.settings.players) {
            sendError(res, 400, `Il faut ${session.settings.players} joueurs connectes avant de lancer la partie.`);
            return;
        }

        buildAssignments(session);
        session.secretAcknowledged = new Set();
        session.clues = [];
        session.activeClueIndex = 0;
        session.status = 'secrets';
        updateSessionRevision(session);
        sendJson(res, 200, buildSessionView(session, player.id));
        return;
    }

    if (req.method === 'POST' && pathname === '/api/session/ack-secret') {
        const body = await readJsonBody(req);
        const session = ensureSession(body.code);
        if (!session) {
            sendError(res, 404, 'Cette session est introuvable.');
            return;
        }

        const player = ensurePlayer(session, body.playerId);
        if (!player) {
            sendError(res, 403, 'Joueur non reconnu pour cette session.');
            return;
        }

        if (session.status !== 'secrets') {
            sendError(res, 400, "La phase de memorisation n'est plus active.");
            return;
        }

        session.secretAcknowledged.add(player.id);
        if (session.secretAcknowledged.size === session.players.length) {
            session.status = 'clues';
            session.activeClueIndex = 0;
        }

        updateSessionRevision(session);
        sendJson(res, 200, buildSessionView(session, player.id));
        return;
    }

    if (req.method === 'POST' && pathname === '/api/session/submit-clue') {
        const body = await readJsonBody(req);
        const session = ensureSession(body.code);
        if (!session) {
            sendError(res, 404, 'Cette session est introuvable.');
            return;
        }

        const player = ensurePlayer(session, body.playerId);
        if (!player) {
            sendError(res, 403, 'Joueur non reconnu pour cette session.');
            return;
        }

        if (session.status !== 'clues') {
            sendError(res, 400, "La phase des mots n'est pas active.");
            return;
        }

        const activePlayer = session.players[session.activeClueIndex];
        if (!activePlayer || activePlayer.id !== player.id) {
            sendError(res, 400, "Ce n'est pas encore ton tour.");
            return;
        }

        const text = String(body.text || '').trim().substring(0, 24);
        if (!text) {
            sendError(res, 400, 'Entre un mot avant de valider.');
            return;
        }

        if (session.clues.some((clue) => clue.playerId === player.id)) {
            sendError(res, 400, 'Tu as deja propose un mot pour ce tour.');
            return;
        }

        session.clues.push({
            playerId: player.id,
            text
        });

        if (session.activeClueIndex >= session.players.length - 1) {
            session.status = 'discussion';
        } else {
            session.activeClueIndex += 1;
        }

        updateSessionRevision(session);
        sendJson(res, 200, buildSessionView(session, player.id));
        return;
    }

    sendError(res, 404, 'Route API introuvable.');
}

const server = http.createServer(async (req, res) => {
    try {
        const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        if (requestUrl.pathname.startsWith('/api/')) {
            await handleApiRequest(req, res, requestUrl.pathname, requestUrl.searchParams);
            return;
        }

        if (requestUrl.pathname === '/favicon.ico') {
            res.writeHead(204);
            res.end();
            return;
        }

        serveStaticFile(req, res, requestUrl.pathname);
    } catch (error) {
        sendError(res, 500, error.message || 'Une erreur serveur est survenue.');
    }
});

server.listen(PORT, HOST, () => {
    const interfaces = os.networkInterfaces();
    const urls = [];

    Object.values(interfaces).forEach((entries) => {
        (entries || []).forEach((entry) => {
            if (entry && entry.family === 'IPv4' && !entry.internal) {
                urls.push(`http://${entry.address}:${PORT}`);
            }
        });
    });

    console.log(`Serveur Undercover lance sur http://localhost:${PORT}`);
    if (urls.length) {
        console.log('Accessible sur le reseau local :');
        urls.forEach((url) => console.log(`- ${url}`));
    } else {
        console.log("Aucune IP reseau locale n'a ete detectee.");
    }
});
