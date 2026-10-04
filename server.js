const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
// 페이지를 다른 주소(학원 웹서버 등)에서 열어도 접속할 수 있도록 CORS 허용
const io = new Server(server, { cors: { origin: '*' } });

// 어느 폴더에서 node를 실행해도 public 폴더를 찾을 수 있도록 절대 경로 사용
app.use(express.static(path.join(__dirname, 'public')));

// 난이도별 단어장 읽어오기
let WORDS = { mild: [], normal: [], spicy: [], extreme: [] };

try {
    const wordsData = fs.readFileSync(path.join(__dirname, 'word.json'), 'utf8');
    WORDS = JSON.parse(wordsData);
    console.log(`[단어장 로드 완료] 순한맛:${WORDS.mild?.length || 0}개 / 보통맛:${WORDS.normal?.length || 0}개 / 불닭맛:${WORDS.spicy?.length || 0}개 / 핵불닭맛:${WORDS.extreme?.length || 0}개`);
} catch (err) {
    console.error('word.json 로드 실패, 기본 단어로 대체합니다.', err);
    WORDS = {
        mild: ['사과', '바나나', '안경'],
        normal: ['스마트폰', '자전거', '노트북'],
        spicy: ['피카츄', '롤러코스터', '카멜레온'],
        extreme: ['양자역학', '피타고라스', '상대성이론']
    };
}

const ROUNDS_PER_PLAYER = 2;   // 한 게임에서 각 플레이어가 출제하는 횟수
const MIN_PLAYERS = 2;
const ROUND_TIME = 60;
const NEXT_ROUND_DELAY = 3000;
const MAX_NICKNAME_LENGTH = 12;
const MAX_CHAT_LENGTH = 100;
const MAX_STROKES = 20000;     // 중간 입장자용 그림 기록 상한 (메모리 보호)
const CANVAS_WIDTH = 480;
const CANVAS_HEIGHT = 390;
const MAX_BRUSH_WIDTH = 30;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// '__proto__' 같은 키로 프로토타입에 접근하지 못하도록 Map 사용
const rooms = new Map();

const difficultyNames = {
    mild: '순한맛 🌶️',
    normal: '보통맛 🌶️🌶️',
    spicy: '불닭맛 🌶️🌶️🌶️️',
    extreme: '핵불닭맛 🔥'
};

// --- 유틸 ---

const isObject = (v) => v !== null && typeof v === 'object';
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// 정답 비교용: 공백 제거 + 소문자화
const normalize = (s) => s.replace(/\s/g, '').toLowerCase();

function cleanNickname(nickname) {
    if (typeof nickname !== 'string') return '';
    return nickname.trim().slice(0, MAX_NICKNAME_LENGTH);
}

function systemChat(roomId, msg) {
    io.to(roomId).emit('chat', { type: 'system', msg });
}

function getGameState(room) {
    return {
        gameActive: room.gameActive,
        currentRound: room.currentRound,
        maxRounds: room.maxRounds,
        timeLeft: room.timeLeft
    };
}

function clearRoomTimers(room) {
    if (room.timer) { clearInterval(room.timer); room.timer = null; }
    if (room.nextRoundTimeout) { clearTimeout(room.nextRoundTimeout); room.nextRoundTimeout = null; }
}

function generateRoomId() {
    for (let i = 0; i < 100; i++) {
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        if (!rooms.has(roomId)) return roomId;
    }
    return null;
}

// 그림 데이터 검증: 형식이 맞지 않으면 null
function sanitizeDraw(data) {
    if (!isObject(data)) return null;
    if (data.type === 'end') return { type: 'end' };
    if (data.type !== 'start' && data.type !== 'move') return null;

    const x = Number(data.x);
    const y = Number(data.y);
    const width = Number(data.width);
    if (![x, y, width].every(Number.isFinite)) return null;
    if (typeof data.color !== 'string' || !COLOR_RE.test(data.color)) return null;

    return {
        type: data.type,
        x: clamp(x, 0, CANVAS_WIDTH),
        y: clamp(y, 0, CANVAS_HEIGHT),
        color: data.color,
        width: clamp(width, 1, MAX_BRUSH_WIDTH)
    };
}

// --- 게임 진행 ---

function endGame(roomId, reason) {
    const room = rooms.get(roomId);
    if (!room) return;

    clearRoomTimers(room);

    // 게임에 참여했던 플레이어들만 점수 순으로 정렬
    const rankings = room.players
        .filter(p => !p.isWaiting)
        .sort((a, b) => b.score - a.score);

    const finishedRounds = room.maxRounds;

    room.gameActive = false;
    room.roundActive = false;
    room.drawerId = null;
    room.currentWord = '';
    room.strokes = [];
    room.currentRound = 0;
    room.maxRounds = 0;
    room.drawOrder = [];
    room.nextDrawerPos = 0;
    // usedWords는 초기화하지 않음: 같은 방에서 다음 게임을 해도 단어장을 다 쓸 때까지 중복 없이 출제

    // 게임 종료 시 관전 중인 유저도 다음 게임을 위해 대기 상태 해제
    room.players.forEach(p => { p.isWaiting = false; });

    io.to(roomId).emit('clear');
    io.to(roomId).emit('game-over', { rankings });
    io.to(roomId).emit('update-players', room.players);
    systemChat(roomId, reason || `🏁 ${finishedRounds}라운드가 모두 끝나 게임이 종료되었습니다!`);
}

// 현재 라운드를 끝내고 잠시 후 다음 라운드를 시작
function finishRound(roomId, msg) {
    const room = rooms.get(roomId);
    if (!room) return;

    clearRoomTimers(room);

    const word = room.currentWord;
    room.roundActive = false;
    room.drawerId = null;
    room.currentWord = '';
    room.strokes = [];

    const isLastRound = room.currentRound >= room.maxRounds;

    io.to(roomId).emit('clear');
    io.to(roomId).emit('round-end', { word });
    io.to(roomId).emit('update-players', room.players);
    systemChat(roomId, `${msg} ${isLastRound ? '잠시 후 최종 결과가 발표됩니다.' : '3초 후 다음 라운드가 시작됩니다.'}`);

    room.nextRoundTimeout = setTimeout(() => {
        room.nextRoundTimeout = null;
        if (rooms.get(roomId) === room) startRound(roomId);
    }, NEXT_ROUND_DELAY);
}

function pickWord(room) {
    const targetWords = (WORDS[room.difficulty] && WORDS[room.difficulty].length > 0)
        ? WORDS[room.difficulty]
        : WORDS.mild;

    let availableWords = targetWords.filter(w => !room.usedWords.includes(w));

    if (availableWords.length === 0) {
        const lastWord = room.usedWords[room.usedWords.length - 1];
        room.usedWords = [];
        availableWords = targetWords.filter(w => w !== lastWord);
        if (availableWords.length === 0) availableWords = targetWords;
    }

    const pickedWord = availableWords[Math.floor(Math.random() * availableWords.length)];
    room.usedWords.push(pickedWord);
    return pickedWord;
}

function startRound(roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.gameActive) return;

    clearRoomTimers(room);

    if (room.drawOrder.length < MIN_PLAYERS) {
        endGame(roomId, '참가자가 부족하여 게임이 종료되었습니다.');
        return;
    }
    if (room.currentRound >= room.maxRounds) {
        endGame(roomId);
        return;
    }

    room.currentRound += 1;
    room.roundActive = true;
    room.timeLeft = ROUND_TIME;
    room.strokes = [];

    // 게임 시작 시 정해진 순서대로 출제자 선정
    const pos = room.nextDrawerPos % room.drawOrder.length;
    room.nextDrawerPos = pos + 1;
    const currentDrawer = room.players.find(p => p.id === room.drawOrder[pos]);

    room.drawerId = currentDrawer.id;
    room.currentWord = pickWord(room);

    io.to(roomId).emit('clear');
    io.to(roomId).emit('game-started', {
        drawerId: currentDrawer.id,
        drawerNickname: currentDrawer.nickname,
        currentRound: room.currentRound,
        maxRounds: room.maxRounds
    });

    io.to(currentDrawer.id).emit('your-turn', { word: room.currentWord });
    systemChat(roomId, `📢 [${room.currentRound}/${room.maxRounds} 라운드 - ${difficultyNames[room.difficulty]}] 시작! 출제자: [${currentDrawer.nickname}]님`);
    io.to(roomId).emit('timer-update', { timeLeft: room.timeLeft });

    room.timer = setInterval(() => {
        room.timeLeft -= 1;
        io.to(roomId).emit('timer-update', { timeLeft: room.timeLeft });

        if (room.timeLeft <= 0) {
            finishRound(roomId, `⏰ 시간 초과! 정답은 [${room.currentWord}]였습니다.`);
        }
    }, 1000);
}

function handleLeaveRoom(socket) {
    const roomId = socket.roomId;
    if (!roomId) return;

    socket.leave(roomId);
    socket.roomId = null;

    const room = rooms.get(roomId);
    if (!room) return;

    const leaver = room.players.find(p => p.id === socket.id);
    room.players = room.players.filter(p => p.id !== socket.id);

    // 출제 순서에서 제거하고, 다음 출제자 위치 보정
    const orderIndex = room.drawOrder.indexOf(socket.id);
    if (orderIndex !== -1) {
        room.drawOrder.splice(orderIndex, 1);
        if (orderIndex < room.nextDrawerPos) room.nextDrawerPos--;
    }

    if (room.players.length === 0) {
        clearRoomTimers(room);
        rooms.delete(roomId);
        return;
    }

    // 방장이 나가면 가장 먼저 들어온 사람에게 방장 위임
    const newHost = leaver?.isHost ? room.players[0] : null;
    if (newHost) newHost.isHost = true;

    io.to(roomId).emit('update-players', room.players);
    systemChat(roomId, `${socket.nickname || '유저'}님이 퇴장하셨습니다.`);
    if (newHost) systemChat(roomId, `👑 ${newHost.nickname}님이 새 방장이 되었습니다.`);

    if (!room.gameActive) return;

    if (room.drawOrder.length < MIN_PLAYERS) {
        endGame(roomId, '참가자가 부족하여 게임이 종료되었습니다.');
    } else if (room.roundActive && room.drawerId === socket.id) {
        // 출제자가 나가면 게임 전체가 아니라 이번 라운드만 건너뜀
        finishRound(roomId, `🚪 출제자가 나가 이번 라운드를 건너뜁니다. 정답은 [${room.currentWord}]였습니다.`);
    }
}

function joinRoom(socket, roomId, nickname) {
    const room = rooms.get(roomId);

    socket.join(roomId);
    socket.roomId = roomId;
    socket.nickname = nickname;

    // 게임이 진행 중일 때 들어오면 관전 모드(isWaiting: true)로 입장
    const isWaiting = room.gameActive;
    // 빈 방에 처음 들어온 사람(방 만든 사람)이 방장
    const isHost = room.players.length === 0;
    room.players.push({ id: socket.id, nickname, score: 0, isWaiting, isHost });

    return isWaiting;
}

// 핸들러 안에서 예외가 나도 서버 전체가 죽지 않도록 감싸기
function safeOn(socket, event, handler) {
    socket.on(event, (...args) => {
        try {
            handler(...args);
        } catch (err) {
            console.error(`[${event}] 처리 중 오류:`, err);
        }
    });
}

io.on('connection', (socket) => {
    console.log('새 클라이언트 접속:', socket.id);

    safeOn(socket, 'create-room', (data) => {
        if (!isObject(data)) return;
        const nickname = cleanNickname(data.nickname);
        if (!nickname) return socket.emit('error-msg', '닉네임을 입력해 주세요.');

        const difficulty = Object.hasOwn(difficultyNames, data.difficulty) ? data.difficulty : 'normal';
        const roomId = generateRoomId();
        if (!roomId) return socket.emit('error-msg', '방이 가득 찼습니다. 잠시 후 다시 시도해 주세요.');

        // 이미 다른 방에 있다면 먼저 나가기
        handleLeaveRoom(socket);

        rooms.set(roomId, {
            players: [],
            gameActive: false,   // 게임(여러 라운드) 진행 중 여부
            roundActive: false,  // 현재 라운드에서 그림을 그리는 중인지 여부
            drawerId: null,
            currentWord: '',
            usedWords: [],
            difficulty,
            timer: null,
            nextRoundTimeout: null,
            timeLeft: ROUND_TIME,
            drawOrder: [],
            nextDrawerPos: 0,
            currentRound: 0,
            maxRounds: 0,
            strokes: []
        });

        joinRoom(socket, roomId, nickname);

        socket.emit('room-created', { roomId, game: getGameState(rooms.get(roomId)), strokes: [] });
        io.to(roomId).emit('update-players', rooms.get(roomId).players);
    });

    safeOn(socket, 'join-room', (data) => {
        if (!isObject(data)) return;
        const nickname = cleanNickname(data.nickname);
        const roomId = typeof data.roomId === 'string' ? data.roomId.trim() : '';
        if (!nickname) return socket.emit('error-msg', '닉네임을 입력해 주세요.');
        if (!rooms.has(roomId)) return socket.emit('error-msg', '존재하지 않는 방 번호입니다.');
        if (socket.roomId === roomId) return;

        handleLeaveRoom(socket);
        // 나가는 과정에서 방이 사라졌을 수 있으므로 다시 확인
        if (!rooms.has(roomId)) return socket.emit('error-msg', '존재하지 않는 방 번호입니다.');

        const room = rooms.get(roomId);
        const isWaiting = joinRoom(socket, roomId, nickname);

        // 중간 입장자도 현재 진행 상황과 그려진 그림을 볼 수 있도록 함께 전달
        socket.emit('room-joined', { roomId, game: getGameState(room), strokes: room.strokes });
        io.to(roomId).emit('update-players', room.players);

        systemChat(roomId, isWaiting
            ? `👀 ${nickname}님이 관전자 모드로 입장하셨습니다. (다음 게임부터 참여)`
            : `${nickname}님이 입장하셨습니다.`);
    });

    safeOn(socket, 'leave-room', () => handleLeaveRoom(socket));

    safeOn(socket, 'start-game', () => {
        const room = rooms.get(socket.roomId);
        if (!room || room.gameActive) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player?.isHost) {
            return socket.emit('error-msg', '방장만 게임을 시작할 수 있습니다.');
        }
        if (room.players.length < MIN_PLAYERS) {
            return socket.emit('error-msg', `게임은 ${MIN_PLAYERS}명 이상부터 시작할 수 있습니다.`);
        }

        // 새 게임 시작 시 방 안의 모든 플레이어를 정식 참여자로 전환
        room.players.forEach(p => {
            p.isWaiting = false;
            p.score = 0;
        });

        room.gameActive = true;
        room.currentRound = 0;
        room.drawOrder = room.players.map(p => p.id);
        room.nextDrawerPos = 0;
        room.maxRounds = room.drawOrder.length * ROUNDS_PER_PLAYER;

        io.to(socket.roomId).emit('update-players', room.players);
        startRound(socket.roomId);
    });

    safeOn(socket, 'draw', (data) => {
        const room = rooms.get(socket.roomId);
        if (!room || !room.roundActive || socket.id !== room.drawerId) return;

        const stroke = sanitizeDraw(data);
        if (!stroke) return;

        if (room.strokes.length < MAX_STROKES) room.strokes.push(stroke);
        socket.to(socket.roomId).emit('draw', stroke);
    });

    safeOn(socket, 'clear', () => {
        const room = rooms.get(socket.roomId);
        if (!room || !room.roundActive || socket.id !== room.drawerId) return;

        room.strokes = [];
        io.to(socket.roomId).emit('clear');
    });

    safeOn(socket, 'chat', (data) => {
        const roomId = socket.roomId;
        const room = rooms.get(roomId);
        if (!room || !isObject(data) || typeof data.msg !== 'string') return;

        const msg = data.msg.trim().slice(0, MAX_CHAT_LENGTH);
        if (!msg) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (room.roundActive) {
            // 출제자는 제시어가 들어간 메시지를 보낼 수 없음
            if (socket.id === room.drawerId) {
                if (normalize(msg).includes(normalize(room.currentWord))) {
                    socket.emit('chat', { type: 'system', msg: '🚫 제시어가 포함된 메시지는 보낼 수 없습니다.' });
                    return;
                }
            } else if (!player.isWaiting && normalize(msg) === normalize(room.currentWord)) {
                // 관전 중인 플레이어(isWaiting: true)는 정답 맞히기 대상에서 제외
                const drawer = room.players.find(p => p.id === room.drawerId);
                player.score += 10;
                if (drawer) drawer.score += 5;

                io.to(roomId).emit('correct-answer', { guesserNickname: player.nickname, word: room.currentWord });
                finishRound(roomId, `🎉 [${player.nickname}]님이 정답 [${room.currentWord}]를 맞히셨습니다!`);
                return;
            }
        }

        io.to(roomId).emit('chat', { type: 'user', id: player.nickname, msg });
    });

    safeOn(socket, 'disconnect', () => {
        handleLeaveRoom(socket);
        console.log('클라이언트 퇴장:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`==================================================`);
    console.log(` 캐치마인드 웹 서버 시작! http://localhost:${PORT}`);
    console.log(`==================================================`);
});
