// ==========================================
// 1. CONFIGURATION & GLOBAL STATE
// ==========================================
const FIREBASE_URL = 'https://qr-codehunt-default-rtdb.asia-southeast1.firebasedatabase.app';
const FIREBASE_SECRET = 'yhqWJQqmv7KY1gAGBUubYbbwaQtfnV3kjYR1hSIK';
let currentUser = null;
let isGameActive = false;

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
            const RARITY_POINTS = { common: 10, rare: 25, epic: 50, legendary: 100, mythic: 250 };
            
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
                    currentUser.maxPossibleScore += (RARITY_POINTS[rarity] || 10);
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
                                currentUser.rawScore += (typeof sub.points_earned === 'number' ? sub.points_earned : (RARITY_POINTS[rarity] || 10));
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
            // Load the Loot Table from your local folder
         if (!window.lootTable) {
             fetch('loot_table.json')
                 .then(res => res.json())
                 .then(data => window.lootTable = data)
                 .catch(err => console.error("Failed to load loot_table.json", err));
         }
                  // Load the Loot Table from your local folder
         if (!window.lootTable) {
             fetch('loot_table.json')
                 .then(res => res.json())
                 .then(data => window.lootTable = data)
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