// ==========================================
// 1. CONFIGURATION & GLOBAL STATE
// ==========================================
const FIREBASE_URL = 'https://qr-codehunt-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_SECRET = 'yhqWJQqmv7KY1gAGBUubYbbwaQtfnV3kjYR1hSIK';
let currentUser = null;
let isGameActive = false;

// ==========================================
// GAME CONFIG — tunable rules, fetched from Firebase (/config)
// ==========================================
// These defaults are used until (or unless) /config.json in Firebase
// provides overrides, so the game still works with zero setup. To change
// rarity points, per-rarity time limits, speed/timeout multipliers, or the
// bomb penalty WITHOUT editing/redeploying code, write a matching node
// under /config in the Realtime Database — see the note at the end of this
// file for the exact shape and how to set it via the console/REST API.
let GAME_CONFIG = {
    rarityPoints:       { common: 10, rare: 25, epic: 50, legendary: 100, mythic: 250 },
    timeLimits:         { common: 30000, rare: 20000, epic: 15000, legendary: 10000, mythic: 5000 }, // ms
    // Ordered list of score tiers, any length. Each tier requires >= minPercent
    // of the time limit still remaining to qualify; multiplier is applied to
    // the base rarity points. getSpeedMultiplier (student.js) sorts these
    // descending and picks the highest tier the answer qualifies for, so you
    // can have 2 tiers or 10 — always include one entry with minPercent: 0 as
    // the floor, or slow answers won't match anything.
    speedThresholds: [
        { minPercent: 0.833, multiplier: 1.0 },
        { minPercent: 0.333, multiplier: 0.7 },
        { minPercent: 0,     multiplier: 0.5 }
    ],
    timeoutMultipliers: { 0: 1.0, 1: 0.7, 2: 0.5 },     // 3+ timeouts on one question always = 0, not configurable
    bombPenalty: 30
};

// Kicks off immediately when core.js loads (before any script tag runs
// login logic), so by the time a student finishes typing a password the
// fetch has almost always already resolved. Every place that reads
// GAME_CONFIG for scoring awaits this first, so it's always safe even on a
// slow connection.
let gameConfigLoaded = fetchGameConfig();

async function fetchGameConfig() {
    try {
        const res = await fetch(`${FIREBASE_URL}/config.json?auth=${FIREBASE_SECRET}`);
        const remote = await res.json();
        if (remote) {
            // Merge one level deep per section, so a config node that only
            // overrides e.g. rarityPoints still falls back to the built-in
            // defaults for timeLimits, multipliers, etc.
            GAME_CONFIG = {
                rarityPoints: { ...GAME_CONFIG.rarityPoints, ...(remote.rarityPoints || {}) },
                timeLimits: { ...GAME_CONFIG.timeLimits, ...(remote.timeLimits || {}) },
                // speedThresholds is an ARRAY, not a keyed object — a
                // one-level-deep {...spread} would merge by array index
                // instead of replacing tiers, silently corrupting anything
                // other than a same-length override. Replace it wholesale
                // when Firebase provides a valid non-empty array, otherwise
                // keep the built-in default.
                speedThresholds: (Array.isArray(remote.speedThresholds) && remote.speedThresholds.length > 0)
                    ? remote.speedThresholds
                    : GAME_CONFIG.speedThresholds,
                timeoutMultipliers: { ...GAME_CONFIG.timeoutMultipliers, ...(remote.timeoutMultipliers || {}) },
                bombPenalty: (typeof remote.bombPenalty === 'number') ? remote.bombPenalty : GAME_CONFIG.bombPenalty
            };
        }
    } catch (e) {
        console.error("Failed to load /config from Firebase — using built-in defaults.", e);
    }
}

// ==========================================
// 2. DOM ELEMENTS (Shared & Core)
// ==========================================
const loginScreen = document.getElementById('login-screen');
const studentDashboard = document.getElementById('student-dashboard');
const teacherDashboard = document.getElementById('teacher-dashboard');
const gameOverOverlay = document.getElementById('game-over-overlay');
const passwordInput = document.getElementById('password-input');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const teacherLogoutBtn = document.getElementById('teacher-logout-btn');
const gameOverLogoutBtn = document.getElementById('game-over-logout-btn');
const displayName = document.getElementById('display-name');
const displayClass = document.getElementById('display-class');

// ==========================================
// 3. SCREEN MANAGEMENT
// ==========================================
function showScreen(screenElement) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    screenElement.classList.add('active');
    gameOverOverlay.classList.add('hidden');
}

function showGameOver() {
    gameOverOverlay.classList.remove('hidden');
    if (window.html5QrcodeScanner) {
        window.html5QrcodeScanner.stop().then(() => {
            window.html5QrcodeScanner.clear();
            window.html5QrcodeScanner = null;
        }).catch(err => console.log(err));
    }
    if (window.studentTimerInterval) clearInterval(window.studentTimerInterval);
}

// ==========================================
// 4. LOGIN & LOGOUT LOGIC
// ==========================================
loginBtn.addEventListener('click', async () => {
    const password = passwordInput.value.trim();
    if (!password) return alert("Please enter your password!");

    // Make sure tunable rules are loaded before either dashboard uses them
    await gameConfigLoaded;

    // Teacher Route
    if (password.toLowerCase() === 'admin') {
        showScreen(teacherDashboard);
        loadTeacherDashboard(); 
        passwordInput.value = '';
        return;
    }

    // Student Route
    loginBtn.textContent = "Checking...";
    try {
        const response = await fetch(`${FIREBASE_URL}/students/${password}.json?auth=${FIREBASE_SECRET}`);
        const studentData = await response.json();
        
        if (studentData && studentData.name) {
            currentUser = { 
             password, 
             name: studentData.name, 
             class: studentData.class,
             answeredQuestions: new Set(),
             collectedItems: [],       // <--- NEW: Array to hold item IDs (e.g., ['item_001', 'item_010'])
             questionTimeouts: {}      // <--- NEW: Tracks how many times they timed out per question
         };

            // 0. Reload previously collected loot for this student (persisted in
            // Firebase), so the inventory survives logout/login instead of
            // resetting every time currentUser is rebuilt.
            try {
                const invRes = await fetch(`${FIREBASE_URL}/inventory/${password}.json?auth=${FIREBASE_SECRET}`);
                const invData = await invRes.json();
                // Older entries (saved before per-item scoring existed) were
                // plain item-id strings; normalize those to the same shape
                // as new entries so renderInventoryGrid can treat them alike.
                currentUser.collectedItems = invData
                    ? Object.values(invData).map(entry =>
                        typeof entry === 'string' ? { item_id: entry, points: 0 } : entry
                      )
                    : [];
            } catch (e) {
                console.error("Failed to load saved loot", e);
            }

            // 1. Fetch past submissions to track personal answers and global uses
            const subsRes = await fetch(`${FIREBASE_URL}/submissions.json?auth=${FIREBASE_SECRET}`);
            const allSubs = await subsRes.json();
            currentUser.globalQuestionUses = {};
            
            if (allSubs) {
                Object.values(allSubs).forEach(sub => {
                    if (sub.student_password === currentUser.password) {
                        currentUser.answeredQuestions.add(sub.question_id);
                    }
                    const qId = sub.question_id;
                    currentUser.globalQuestionUses[qId] = (currentUser.globalQuestionUses[qId] || 0) + 1;
                });
            }

            // 2. Fetch Questions & Calculate Progress (Excluding Hints AND Bombs)
            const questionsRes = await fetch(`${FIREBASE_URL}/questions.json?auth=${FIREBASE_SECRET}`);
            const allQuestions = await questionsRes.json();
            
            currentUser.totalQuestions = 0;
            currentUser.questionMaxUses = {};
            currentUser.maxPossibleScore = 0;
            
            if (allQuestions) {
                for (const [qId, q] of Object.entries(allQuestions)) {
                    // Safely check chest type (defaults to 'reward' if missing or mistyped)
                    const chestType = q.chest_type ? q.chest_type.toLowerCase().trim() : 'reward';
                    
                    // Skip hints and bombs! They are optional events, not required objectives.
                    if (chestType === 'hint' || chestType === 'bomb') continue; 
                    
                    currentUser.totalQuestions++;
                    currentUser.questionMaxUses[qId] = q.max_uses || 99;
                    const rarity = q.rarity ? q.rarity.toLowerCase().trim() : 'common';
                    currentUser.maxPossibleScore += (GAME_CONFIG.rarityPoints[rarity] || 10);
                }
            }
            if (currentUser.maxPossibleScore === 0) currentUser.maxPossibleScore = 1;

            // 3. Calculate Local Stats for Finish Screen
            currentUser.correctCount = 0;
            currentUser.rawScore = 0;
            currentUser.answeredRarities = { common: 0, rare: 0, epic: 0, legendary: 0, mythic: 0 };

            if (allQuestions && allSubs) {
                Object.values(allSubs).forEach(sub => {
                    if (sub.student_password === currentUser.password) {
                        const qId = sub.question_id;
                        const q = allQuestions[qId];
                        if (q) {
                            const rarity = q.rarity ? q.rarity.toLowerCase().trim() : 'common';
                            if (currentUser.answeredRarities[rarity] !== undefined) {
                                currentUser.answeredRarities[rarity]++;
                            }
                            
                            const chestType = q.chest_type ? q.chest_type.toLowerCase().trim() : 'reward';
                            // Only award points for correct answers on non-bomb chests.
                            // Use the score actually recorded on the submission
                            // (base rarity points x speed/timeout multipliers) so
                            // this always matches the teacher leaderboard. Older
                            // submissions made before scoring was recorded fall
                            // back to flat rarity points.
                            if (chestType !== 'bomb' && sub.selected_answer === q.correct_answer) {
                                currentUser.correctCount++;
                                currentUser.rawScore += (typeof sub.points_earned === 'number' ? sub.points_earned : (GAME_CONFIG.rarityPoints[rarity] || 10));
                            }
                        }
                    }
                });
            }

            // 4. Check if already finished personally
            let resolvedChests = 0;
            if (currentUser.questionMaxUses) {
                for (const [qId, maxUses] of Object.entries(currentUser.questionMaxUses)) {
                    const openedByMe = currentUser.answeredQuestions.has(qId);
                    const claimedGlobally = (currentUser.globalQuestionUses[qId] || 0) >= maxUses;
                    if (openedByMe || claimedGlobally) resolvedChests++;
                }
            }
            const isFinished = resolvedChests >= currentUser.totalQuestions && currentUser.totalQuestions > 0;

            // 5. Route to correct screen
            // Load the Loot Table from your local folder. window.lootTable is
            // the raw { rarity: [ {item_id, minPercent, ...}, ... ] } shape
            // used to pick a drop; window.lootItemsById is a flattened
            // item_id -> item lookup, used for inventory display.
            if (!window.lootTable) {
                fetch('loot_table.json')
                    .then(res => res.json())
                    .then(data => {
                        window.lootTable = data;
                        window.lootItemsById = {};
                        Object.entries(data).forEach(([rarity, drops]) => {
                            drops.forEach(drop => {
                                window.lootItemsById[drop.item_id] = { ...drop, rarity };
                            });
                        });
                    })
                    .catch(err => console.error("Failed to load loot_table.json", err));
            }
            displayName.textContent = currentUser.name;
            displayClass.textContent = currentUser.class;
            
            // Update game status BEFORE checking isGameActive
            await checkGameStatusAndUpdateTimer(); 

            if (isFinished) {
                showFinishScreen();
            } else if (isGameActive) {
                showScreen(studentDashboard);
                updateProgressTracker(); 
                startStudentTimer(); 
                startScanner();
                startAnnouncementPolling(); 
            } else {
                showGameOver();
            }
        } else {
            alert("Password not found. Please check with your teacher.");
        }
    } catch (error) {
        console.error("Login error:", error);
        alert("Connection error. Check your internet or Firebase URL.");
    }
    loginBtn.textContent = "Login";
    passwordInput.value = '';
});

passwordInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') loginBtn.click(); });

function handleLogout() {
    currentUser = null;
    if (window.studentTimerInterval) clearInterval(window.studentTimerInterval);
    if (window.html5QrcodeScanner) {
        window.html5QrcodeScanner.stop().then(() => {
            window.html5QrcodeScanner.clear();
            window.html5QrcodeScanner = null;
        }).catch(err => console.log(err));
    }

    // FIX: Force-hide ALL overlays so they don't bleed into the login screen
    const overlaysToHide = [
        'finish-overlay', 
        'parchment-overlay', 
        'chest-overlay', 
        'scroll-overlay', 
        'bomb-overlay', 
        'locked-overlay',
        'hint-overlay', // Added Hint Overlay
        'secret-code-modal', // Added Secret Code Modal
        'game-over-overlay'
    ];
    overlaysToHide.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });

    showScreen(loginScreen);
    if (passwordInput) passwordInput.value = '';
}

logoutBtn.addEventListener('click', handleLogout);
teacherLogoutBtn.addEventListener('click', handleLogout);
gameOverLogoutBtn.addEventListener('click', handleLogout);
// ==========================================
// HOW TO SET /config IN FIREBASE
// ==========================================
// Paste this into the Firebase console at the root of your RTDB (or PUT it
// to ${FIREBASE_URL}/config.json?auth=...) to override any of the defaults
// above. You only need to include the fields you want to change — anything
// left out keeps its built-in default.
//
// {
//   "config": {
//     "rarityPoints":       { "common": 10, "rare": 25, "epic": 50, "legendary": 100, "mythic": 250 },
//     "timeLimits":         { "common": 30000, "rare": 20000, "epic": 15000, "legendary": 10000, "mythic": 5000 },
//     "speedThresholds": [
//       { "minPercent": 0.8, "multiplier": 1.0 },
//       { "minPercent": 0.6, "multiplier": 0.85 },
//       { "minPercent": 0.4, "multiplier": 0.7 },
//       { "minPercent": 0.2, "multiplier": 0.55 },
//       { "minPercent": 0,   "multiplier": 0.4 }
//     ],
//     "timeoutMultipliers": { "0": 1.0, "1": 0.7, "2": 0.5 },
//     "bombPenalty": 30
//   }
// }