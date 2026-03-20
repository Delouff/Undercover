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

function normalizeChatMessage(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().substring(0, 100);
}

function normalizeVoteRole(value) {
    const role = String(value || '').trim().toLowerCase();
    return role === 'mrwhite' || role === 'undercover' ? role : '';
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

function randomMessageId() {
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

function roleLabel(role) {
    if (role === 'mrwhite') return 'MrWhite';
    if (role === 'undercover') return 'Undercover';
    return 'Civil';
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

function removePlayerFromSession(session, playerId) {
    const playerIndex = session.players.findIndex((entry) => entry.id === playerId);
    if (playerIndex === -1) {
        return { removed: false, deleted: false };
    }

    const [removedPlayer] = session.players.splice(playerIndex, 1);

    if (session.assignments) {
        delete session.assignments[playerId];
    }

    session.alivePlayerIds = (session.alivePlayerIds || []).filter((entryId) => entryId !== playerId);

    if (session.secretAcknowledged) {
        session.secretAcknowledged.delete(playerId);
    }

    session.clues = (session.clues || []).filter((clue) => clue.playerId !== playerId);
    delete session.votes[playerId];
    Object.keys(session.votes || {}).forEach((voterId) => {
        if (session.votes[voterId]?.targetPlayerId === playerId) {
            delete session.votes[voterId];
        }
    });

    if (session.players.length === 0) {
        sessions.delete(session.code);
        return {
            removed: true,
            deleted: true,
            removedPlayer
        };
    }

    if (session.hostPlayerId === playerId) {
        session.hostPlayerId = session.players[0].id;
    }

    if (session.status === 'secrets') {
        if (session.secretAcknowledged.size === session.players.length && session.players.length > 0) {
            session.status = 'clues';
            session.activeClueIndex = 0;
        }
    } else if (session.status === 'clues') {
        const alivePlayers = getAlivePlayers(session);
        if (alivePlayers.length === 0) {
            sessions.delete(session.code);
            return {
                removed: true,
                deleted: true,
                removedPlayer
            };
        }

        if (session.clues.length >= alivePlayers.length) {
            session.status = 'discussion';
            session.discussionMessages = [];
            session.votes = {};
            session.activeClueIndex = 0;
        } else {
            session.activeClueIndex = Math.min(session.clues.length, Math.max(0, alivePlayers.length - 1));
        }
    } else if (session.status === 'discussion') {
        resolveDiscussion(session);
    } else if (session.status === 'finished') {
        const winner = determineWinner(session);
        if (winner) {
            session.winner = winner;
        }
    }

    return {
        removed: true,
        deleted: false,
        removedPlayer
    };
}

function ensureSession(sessionCode) {
    return sessions.get(String(sessionCode || '').trim().toUpperCase());
}

function ensurePlayer(session, playerId) {
    return session.players.find((entry) => entry.id === playerId);
}

function getAlivePlayers(session) {
    const aliveIds = new Set(session.alivePlayerIds || []);
    return session.players.filter((entry) => aliveIds.has(entry.id));
}

function isPlayerAlive(session, playerId) {
    return (session.alivePlayerIds || []).includes(playerId);
}

function getConfiguredGuessRoles(session) {
    const roles = [];
    if (session.settings.mrWhite) roles.push('mrwhite');
    if (session.settings.undercover) roles.push('undercover');
    return roles;
}

function getActiveCluePlayer(session) {
    if (session.status !== 'clues') {
        return null;
    }

    const alivePlayers = getAlivePlayers(session);
    return alivePlayers[session.activeClueIndex] || null;
}

function getCluePlayerName(session, playerId) {
    return session.players.find((entry) => entry.id === playerId)?.name || 'Joueur';
}

function determineWinner(session) {
    const alivePlayers = getAlivePlayers(session);
    const civilsAlive = alivePlayers.filter((player) => session.assignments[player.id]?.role === 'civil').length;
    const undercoverAlive = alivePlayers.some((player) => session.assignments[player.id]?.role === 'undercover');
    const mrWhiteAlive = alivePlayers.some((player) => session.assignments[player.id]?.role === 'mrwhite');

    if (civilsAlive === 0 && (undercoverAlive || mrWhiteAlive)) {
        if (undercoverAlive && mrWhiteAlive) {
            return {
                team: 'special',
                title: 'Victoire de MrWhite et de l Undercover !',
                message: 'Les roles speciaux ont reussi a survivre jusqu a la fin de la partie.'
            };
        }
        if (undercoverAlive) {
            return {
                team: 'undercover',
                title: 'Victoire de l Undercover !',
                message: 'L Undercover a reussi a tromper tout le monde.'
            };
        }
        return {
            team: 'mrwhite',
            title: 'Victoire de MrWhite !',
            message: 'MrWhite a su rester cache jusqu a la fin.'
        };
    }

    if (!undercoverAlive && !mrWhiteAlive && civilsAlive > 0) {
        return {
            team: 'civil',
            title: 'Victoire des Civils !',
            message: 'Tous les roles speciaux ont ete elimines.'
        };
    }

    return null;
}

function buildVoteSummary(session, targetId, ballots) {
    const target = ensurePlayer(session, targetId);
    const actualRole = session.assignments[targetId]?.role || 'civil';
    const roleTallies = new Map();

    ballots.forEach((ballot) => {
        if (!ballot.guessedRole) return;
        roleTallies.set(ballot.guessedRole, (roleTallies.get(ballot.guessedRole) || 0) + 1);
    });

    const sortedRoles = [...roleTallies.entries()].sort((a, b) => b[1] - a[1]);
    const bestRole = sortedRoles[0] || null;
    const tiedRole = bestRole
        ? sortedRoles.some((entry, index) => index > 0 && entry[1] === bestRole[1])
        : false;
    const guessedRole = bestRole && !tiedRole ? bestRole[0] : null;
    const guessedRoleLabel = guessedRole ? roleLabel(guessedRole) : null;
    const actualRoleLabel = roleLabel(actualRole);
    const voteWasCorrect = Boolean(guessedRole && guessedRole === actualRole);
    let message = '';

    if (guessedRole) {
        message = `${target.name} a ete elimine. Le salon le pensait ${guessedRoleLabel}. Son role reel etait ${actualRoleLabel}.`;
    } else {
        message = `${target.name} a ete elimine, mais le salon ne s est pas accorde sur son role. Son role reel etait ${actualRoleLabel}.`;
    }

    return {
        roundNumber: session.roundNumber,
        type: 'elimination',
        title: `${target.name} elimine`,
        message,
        eliminatedPlayerId: target.id,
        eliminatedPlayerName: target.name,
        guessedRole,
        guessedRoleLabel,
        actualRole,
        actualRoleLabel,
        voteWasCorrect
    };
}

function beginNextRound(session, summary) {
    session.roundNumber += 1;
    session.status = 'clues';
    session.activeClueIndex = 0;
    session.clues = [];
    session.discussionMessages = [];
    session.votes = {};
    session.lastRoundSummary = summary;
}

function finishSession(session, summary, winner) {
    session.status = 'finished';
    session.activeClueIndex = 0;
    session.clues = [];
    session.discussionMessages = [];
    session.votes = {};
    session.lastRoundSummary = summary;
    session.winner = winner;
}

function returnSessionToWaiting(session) {
    session.status = 'waiting';
    session.assignments = null;
    session.alivePlayerIds = session.players.map((entry) => entry.id);
    session.secretAcknowledged = new Set();
    session.clues = [];
    session.activeClueIndex = 0;
    session.roundNumber = 1;
    session.discussionMessages = [];
    session.votes = {};
    session.lastRoundSummary = null;
    session.winner = null;
}

function resolveDiscussion(session) {
    const alivePlayers = getAlivePlayers(session);
    const eligibleVoterCount = alivePlayers.length;
    const votes = Object.values(session.votes || {});

    if (votes.length !== eligibleVoterCount || eligibleVoterCount === 0) {
        return;
    }

    const tally = new Map();
    votes.forEach((vote) => {
        const key = vote.type === 'skip' ? 'skip' : vote.targetPlayerId;
        tally.set(key, (tally.get(key) || 0) + 1);
    });

    const sortedTargets = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const bestTarget = sortedTargets[0] || null;
    const hasTie = bestTarget
        ? sortedTargets.some((entry, index) => index > 0 && entry[1] === bestTarget[1])
        : false;

    if (!bestTarget || hasTie || bestTarget[0] === 'skip') {
        const summary = {
            roundNumber: session.roundNumber,
            type: 'skip',
            title: 'Debat passe',
            message: hasTie
                ? 'Le vote est reste indecis. Personne n est elimine et un nouveau tour commence.'
                : 'Le salon a choisi de passer le debat. Personne n est elimine et un nouveau tour commence.'
        };
        beginNextRound(session, summary);
        return;
    }

    const targetId = bestTarget[0];
    const targetBallots = votes.filter((vote) => vote.type === 'accuse' && vote.targetPlayerId === targetId);
    const summary = buildVoteSummary(session, targetId, targetBallots);

    session.alivePlayerIds = (session.alivePlayerIds || []).filter((entryId) => entryId !== targetId);

    const winner = determineWinner(session);
    if (winner) {
        finishSession(session, summary, winner);
        return;
    }

    beginNextRound(session, summary);
}

function buildSessionView(session, playerId) {
    const player = session.players.find((entry) => entry.id === playerId);
    const host = session.players.find((entry) => entry.id === session.hostPlayerId);
    const assignment = session.assignments ? session.assignments[playerId] : null;
    const activePlayer = getActiveCluePlayer(session);
    const acknowledgedSet = session.secretAcknowledged || new Set();
    const aliveIds = new Set(session.alivePlayerIds || []);
    const alivePlayers = getAlivePlayers(session);
    const configuredGuessRoles = getConfiguredGuessRoles(session);
    const playerVote = session.votes ? session.votes[playerId] : null;

    return {
        code: session.code,
        revision: session.revision,
        status: session.status,
        isHost: session.hostPlayerId === playerId,
        self: player ? {
            id: player.id,
            name: player.name,
            alive: aliveIds.has(player.id)
        } : null,
        hostName: host ? host.name : 'Hote',
        settings: session.settings,
        playerCount: session.players.length,
        aliveCount: alivePlayers.length,
        roundNumber: session.roundNumber,
        canStart: session.status === 'waiting'
            && session.hostPlayerId === playerId
            && session.players.length === session.settings.players,
        players: session.players.map((entry) => ({
            id: entry.id,
            name: entry.name,
            isHost: entry.id === session.hostPlayerId,
            alive: aliveIds.has(entry.id),
            acknowledged: acknowledgedSet.has(entry.id),
            clueSubmitted: session.clues.some((clue) => clue.playerId === entry.id),
            hasVoted: Boolean(session.votes && session.votes[entry.id]),
            revealedRole: !aliveIds.has(entry.id) || session.status === 'finished'
                ? session.assignments?.[entry.id]?.role || null
                : null
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
        canSubmitClue: session.status === 'clues' && activePlayer ? activePlayer.id === playerId : false,
        clues: session.clues.map((clue) => ({
            playerId: clue.playerId,
            playerName: getCluePlayerName(session, clue.playerId),
            text: clue.text
        })),
        submittedCount: session.clues.length,
        totalTurns: alivePlayers.length,
        guessRoleOptions: configuredGuessRoles.map((role) => ({
            id: role,
            label: roleLabel(role)
        })),
        discussionMessages: (session.discussionMessages || []).slice(-80).map((message) => ({
            id: message.id,
            playerId: message.playerId,
            playerName: message.playerName,
            text: message.text,
            sentAt: message.sentAt
        })),
        canChat: session.status === 'discussion' && aliveIds.has(playerId),
        canVote: session.status === 'discussion' && aliveIds.has(playerId) && !playerVote,
        yourVote: playerVote ? {
            type: playerVote.type,
            targetPlayerId: playerVote.targetPlayerId || null,
            targetPlayerName: playerVote.targetPlayerId ? getCluePlayerName(session, playerVote.targetPlayerId) : null,
            guessedRole: playerVote.guessedRole || null,
            guessedRoleLabel: playerVote.guessedRole ? roleLabel(playerVote.guessedRole) : null
        } : null,
        votesSubmittedCount: Object.keys(session.votes || {}).length,
        eligibleVotersCount: alivePlayers.length,
        lastRoundSummary: session.lastRoundSummary,
        winner: session.winner
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
            alivePlayerIds: [hostPlayerId],
            secretAcknowledged: new Set(),
            clues: [],
            activeClueIndex: 0,
            roundNumber: 1,
            discussionMessages: [],
            votes: {},
            lastRoundSummary: null,
            winner: null,
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

        if (session.status !== 'waiting') {
            sendError(res, 400, 'La partie a deja commence.');
            return;
        }

        if (!playerName) {
            sendError(res, 400, 'Entre un pseudo avant de rejoindre la session.');
            return;
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
        session.alivePlayerIds.push(playerId);
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

    if (req.method === 'POST' && pathname === '/api/session/leave') {
        const body = await readJsonBody(req);
        const session = ensureSession(body.code);
        if (!session) {
            sendJson(res, 200, { left: true, deleted: true });
            return;
        }

        const player = ensurePlayer(session, body.playerId);
        if (!player) {
            sendJson(res, 200, { left: true, deleted: false });
            return;
        }

        const removal = removePlayerFromSession(session, player.id);
        if (!removal.deleted) {
            updateSessionRevision(session);
        }

        sendJson(res, 200, {
            left: true,
            deleted: removal.deleted
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/session/kick') {
        const body = await readJsonBody(req);
        const session = ensureSession(body.code);
        if (!session) {
            sendError(res, 404, 'Cette session est introuvable.');
            return;
        }

        const hostPlayer = ensurePlayer(session, body.playerId);
        if (!hostPlayer) {
            sendError(res, 403, 'Joueur non reconnu pour cette session.');
            return;
        }

        if (session.hostPlayerId !== hostPlayer.id) {
            sendError(res, 403, "Seul l hote peut exclure un joueur.");
            return;
        }

        const targetPlayerId = String(body.targetPlayerId || '').trim();
        const targetPlayer = ensurePlayer(session, targetPlayerId);
        if (!targetPlayer) {
            sendError(res, 404, 'Ce joueur n est plus dans la session.');
            return;
        }

        if (targetPlayer.id === hostPlayer.id) {
            sendError(res, 400, 'L hote ne peut pas s exclure lui-meme.');
            return;
        }

        const removal = removePlayerFromSession(session, targetPlayer.id);
        if (removal.deleted) {
            sendJson(res, 200, {
                kickedPlayerId: targetPlayer.id,
                kickedPlayerName: targetPlayer.name,
                deleted: true
            });
            return;
        }

        updateSessionRevision(session);
        sendJson(res, 200, buildSessionView(session, hostPlayer.id));
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
            sendError(res, 403, "Seul l hote peut modifier les parametres.");
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
            sendError(res, 403, "Seul l hote peut lancer la partie.");
            return;
        }

        if (session.players.length !== session.settings.players) {
            sendError(res, 400, `Il faut ${session.settings.players} joueurs connectes avant de lancer la partie.`);
            return;
        }

        buildAssignments(session);
        session.alivePlayerIds = session.players.map((entry) => entry.id);
        session.secretAcknowledged = new Set();
        session.clues = [];
        session.activeClueIndex = 0;
        session.roundNumber = 1;
        session.discussionMessages = [];
        session.votes = {};
        session.lastRoundSummary = null;
        session.winner = null;
        session.status = 'secrets';
        updateSessionRevision(session);
        sendJson(res, 200, buildSessionView(session, player.id));
        return;
    }

    if (req.method === 'POST' && pathname === '/api/session/return-to-lobby') {
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
            sendError(res, 403, "Seul l hote peut renvoyer tout le monde au salon.");
            return;
        }

        if (session.status === 'waiting') {
            sendJson(res, 200, buildSessionView(session, player.id));
            return;
        }

        returnSessionToWaiting(session);
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
            sendError(res, 400, "La phase de memorisation n est plus active.");
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
            sendError(res, 400, 'La phase des mots n est pas active.');
            return;
        }

        if (!isPlayerAlive(session, player.id)) {
            sendError(res, 400, 'Ce joueur a deja ete elimine.');
            return;
        }

        const activePlayer = getActiveCluePlayer(session);
        if (!activePlayer || activePlayer.id !== player.id) {
            sendError(res, 400, 'Ce n est pas encore ton tour.');
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

        const alivePlayers = getAlivePlayers(session);
        if (session.clues.length >= alivePlayers.length) {
            session.status = 'discussion';
            session.discussionMessages = [];
            session.votes = {};
            session.activeClueIndex = 0;
        } else {
            session.activeClueIndex += 1;
        }

        updateSessionRevision(session);
        sendJson(res, 200, buildSessionView(session, player.id));
        return;
    }

    if (req.method === 'POST' && pathname === '/api/session/chat') {
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

        if (session.status !== 'discussion') {
            sendError(res, 400, 'Le debat nest pas encore ouvert.');
            return;
        }

        if (!isPlayerAlive(session, player.id)) {
            sendError(res, 400, 'Les joueurs elimines ne peuvent plus parler dans le debat.');
            return;
        }

        const text = normalizeChatMessage(body.text);
        if (!text) {
            sendError(res, 400, 'Entre un message avant de lenvoyer.');
            return;
        }

        session.discussionMessages.push({
            id: randomMessageId(),
            playerId: player.id,
            playerName: player.name,
            text,
            sentAt: Date.now()
        });

        updateSessionRevision(session);
        sendJson(res, 200, buildSessionView(session, player.id));
        return;
    }

    if (req.method === 'POST' && pathname === '/api/session/vote') {
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

        if (session.status !== 'discussion') {
            sendError(res, 400, 'Le vote nest pas ouvert.');
            return;
        }

        if (!isPlayerAlive(session, player.id)) {
            sendError(res, 400, 'Les joueurs elimines ne peuvent plus voter.');
            return;
        }

        if (session.votes[player.id]) {
            sendError(res, 400, 'Tu as deja vote pour ce debat.');
            return;
        }

        const voteType = String(body.type || '').trim().toLowerCase();
        if (voteType !== 'skip' && voteType !== 'accuse') {
            sendError(res, 400, 'Vote invalide.');
            return;
        }

        if (voteType === 'skip') {
            session.votes[player.id] = {
                type: 'skip',
                submittedAt: Date.now()
            };
        } else {
            const targetPlayerId = String(body.targetPlayerId || '').trim();
            const guessedRole = normalizeVoteRole(body.guessedRole);
            const target = ensurePlayer(session, targetPlayerId);
            const allowedRoles = getConfiguredGuessRoles(session);

            if (!target || !isPlayerAlive(session, target.id)) {
                sendError(res, 400, 'Ce joueur ne peut pas etre vise par le vote.');
                return;
            }

            if (!guessedRole || !allowedRoles.includes(guessedRole)) {
                sendError(res, 400, 'Choisis un role valide avant de voter.');
                return;
            }

            session.votes[player.id] = {
                type: 'accuse',
                targetPlayerId: target.id,
                guessedRole,
                submittedAt: Date.now()
            };
        }

        resolveDiscussion(session);
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
