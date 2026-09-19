// ==========================================
// 1. STUDENT STATE & DOM ELEMENTS
// ==========================================
let html5QrcodeScanner = null;
let currentQuestionId = null;
let studentTimerInterval = null;
let questionTimerInterval = null;

const studentTimer = document.getElementById('student-timer');
const scannerArea = document.getElementById('scanner-area');
const questionModal = document.getElementById('question-modal'); // Kept only for "Already Answered" fallback
const qText = document.getElementById('q-text');
const qOptions = document.getElementById('q-options');
const feedbackArea = document.getElementById('feedback-area');
const feedbackText = document.getElementById('feedback-text');
const manualInput = document.getElementById('manual-qr-input');
const manualSubmitBtn = document.getElementById('manual-submit-btn');
const progressTracker = document.getElementById('progress-tracker');
const announcementHistoryToggle = document.getElementById('announcement-history-toggle');
const announcementHistoryDropdown = document.getElementById('announcement-history-dropdown');
if (announcementHistoryToggle && announcementHistoryDropdown) {
    announcementHistoryToggle.addEventListener('click', () => {
        announcementHistoryDropdown.classList.toggle('hidden');
    });
}

// Inventory / Loot UI Elements
const openInventoryBtn = document.getElementById('open-inventory-btn');
const inventoryModal = document.getElementById('inventory-modal');
const closeInventoryBtn = document.getElementById('close-inventory-btn');
const inventoryBackScannerBtn = document.getElementById('inventory-back-scanner');
const inventoryTotalValueEl = document.getElementById('inventory-total-value');
const itemDetailModal = document.getElementById('item-detail-modal');
const closeDetailBtn = document.getElementById('close-detail-btn');

// Retro Overlay Elements
const chestOverlay = document.getElementById('chest-overlay');
const chestSprite = document.getElementById('chest-sprite');
const chestInstruction = document.getElementById('chest-instruction');
const screenFlash = document.getElementById('screen-flash');
const scrollOverlay = document.getElementById('scroll-overlay');
const parchmentOverlay = document.getElementById('parchment-overlay');

// Rarity/time-limit table and the speed/timeout multiplier curves all come
// from GAME_CONFIG now (see core.js), fetched from Firebase's /config node
// so these can be tuned without editing code. Always read GAME_CONFIG.* at
// the point of use (not into a const captured at load time) — fetchGameConfig
// replaces the whole GAME_CONFIG object once the fetch resolves, so an early
// reference to e.g. GAME_CONFIG.timeLimits would go stale.

// Single source of truth for scoring multipliers. Used both to compute the
// points a correct answer earns AND to display/store the loot drop value, so
// the two numbers can never drift apart again.
function getSpeedMultiplier(timeRemaining, timeLimit) {
    let speedPercent = timeLimit > 0 ? (timeRemaining / timeLimit) : 0;
    speedPercent = Math.max(0, Math.min(1, speedPercent));

    // GAME_CONFIG.speedThresholds is an ordered list of any length —
    // { minPercent, multiplier } tiers. Sort descending and take the
    // highest tier this answer qualifies for (same pattern used for loot
    // brackets in processLootDrop), so 2 tiers or 10 both just work.
    const sorted = [...GAME_CONFIG.speedThresholds].sort((a, b) => b.minPercent - a.minPercent);
    const tier = sorted.find(t => speedPercent >= t.minPercent) || sorted[sorted.length - 1];
    return tier.multiplier;
}

function getTimeoutMultiplier(timeouts) {
    if (timeouts >= 3) return 0; // 3rd timeout on this question = no score, no loot (not configurable)
    return GAME_CONFIG.timeoutMultipliers[timeouts] ?? 1.0;
}
const CHEST_SUSPENSE_PHRASES = [
    "Berani buka kotak ini?",
    "Tunggu sebentar... apakah ini bomb?",
    "Buka saja, mungkin ada harta karun!",
    "Yang berani, yang menang!",
    "COba tebak, apa isinya?",
    "Apa ini? Harta atau bencana?",
    "Jangan rakus, pikirkan dulu!",
    "Hati-hati, kotak ini misterius!",
    "ayo berdoa, semoga beruntung!",
    "Mungkin ini kotak ajaib!",
    "Mungkin saja kotak ini berisi ijazah beliau"
];
// ==========================================
// 2. GAME TIMER & STATUS
// ==========================================
async function checkGameStatusAndUpdateTimer() {
    try {
        const response = await fetch(`${FIREBASE_URL}/gameSettings.json?auth=${FIREBASE_SECRET}`);
        const settings = await response.json();
        if (settings && settings.isActive && settings.endTime) {
            const now = Date.now();
            const remaining = settings.endTime - now;
            if (remaining <= 0) {
                isGameActive = false;
                studentTimer.textContent = "⏳ 00:00";
            } else {
                isGameActive = true;
                const mins = Math.floor(remaining / 60000);
                const secs = Math.floor((remaining % 60000) / 1000);
                studentTimer.textContent = ` ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
            }
        } else {
            isGameActive = false;
            studentTimer.textContent = "⏳ Ended";
        }
    } catch (error) {
        console.error("Timer error:", error);
        isGameActive = false;
    }
}

function startStudentTimer() {
    if (studentTimerInterval) clearInterval(studentTimerInterval);
    checkGameStatusAndUpdateTimer();
    studentTimerInterval = setInterval(async () => {
        await checkGameStatusAndUpdateTimer();
        if (!isGameActive) {
            clearInterval(studentTimerInterval);
            showGameOver();
        }
    }, 1000);
}

// ==========================================
// 3. QR SCANNER & MANUAL ENTRY
// ==========================================
async function startScanner() {
    if (html5QrcodeScanner) return;
    html5QrcodeScanner = new Html5Qrcode("reader");
    const config = { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 };
    try {
        await html5QrcodeScanner.start({ facingMode: "environment" }, config, onScanSuccess, onScanFailure);
    } catch (err) {
        try {
            await html5QrcodeScanner.start({ facingMode: "user" }, config, onScanSuccess, onScanFailure);
        } catch (err2) {
            document.getElementById('reader').innerHTML = "<p style='padding:20px; color:red;'>Camera access denied. Use manual entry.</p>";
        }
    }
}

function onScanSuccess(decodedText) {
    let questionId = decodedText;
    if (decodedText.includes('?q=')) questionId = decodedText.split('?q=')[1].split('&')[0];
    else if (decodedText.includes('&q=')) questionId = decodedText.split('&q=')[1].split('&')[0];
    loadQuestion(questionId);
}

function onScanFailure(error) { /* Ignore */ }

manualSubmitBtn.addEventListener('click', () => {
    const qId = manualInput.value.trim();
    if (qId) { loadQuestion(qId); manualInput.value = ''; }
});

// ==========================================
// 4. QUESTION LOADING (ALL GO THROUGH CHEST)
// ==========================================
async function loadQuestion(questionId) {
    if (!isGameActive) { showGameOver(); return; }

    // Prevent duplicate answers
    if (currentUser && currentUser.answeredQuestions.has(questionId)) {
        if (html5QrcodeScanner) html5QrcodeScanner.pause(true);
        scannerArea.classList.add('hidden');
        feedbackArea.classList.add('hidden');
        questionModal.classList.remove('hidden');
        qText.textContent = `⚠️ Kamu sudah menjawab soal ini "${questionId}"!`;
        qText.style.color = "#f44336";
        qOptions.innerHTML = `<button class="option-btn" style="background-color:#4CAF50;" onclick="resetToScanner()">Back to Scanner</button>`;
        return;
    }

    currentQuestionId = questionId;
    if (html5QrcodeScanner) html5QrcodeScanner.pause(true);
    scannerArea.classList.add('hidden');
    feedbackArea.classList.add('hidden');

    try {
        const response = await fetch(`${FIREBASE_URL}/questions/${questionId}.json?auth=${FIREBASE_SECRET}`);
        const qData = await response.json();
        if (!qData || !qData.text) throw new Error("Kode sakti tidak ditemukan!");

        const rarity = qData.rarity ? qData.rarity.toLowerCase().trim() : 'common';
        
        // --- NEW: CHECK USAGE LIMIT ---
        const maxUses = qData.max_uses || 99; // Default to 99 if column is empty
        const currentUses = currentUser.globalQuestionUses[questionId] || 0;

        if (currentUses >= maxUses) {
            // The chest is locked! Show the locked overlay and abort.
            document.getElementById('locked-overlay').classList.remove('hidden');
            return; 
        }
        // ------------------------------

        // NO MORE FORK! All questions go through the chest sequence.
        startChestSequence(qData, rarity);

    } catch (error) {
        console.error("Error loading question:", error);
        questionModal.classList.remove('hidden');
        qText.innerHTML = `❌ Error: Question "${questionId}" not found!`;
        qText.style.color = "red";
        qOptions.innerHTML = `<button class="option-btn" style="background-color:#f44336;" onclick="resetToScanner()">Go Back</button>`;
    }
}

// ==========================================
// 5. CHEST -> SCROLL -> PARCHMENT SEQUENCE
// ==========================================
async function startChestSequence(qData, rarity) {
    // 1. Reset Chest Overlay state
    chestOverlay.classList.remove('hidden');
    scrollOverlay.classList.add('hidden');
    parchmentOverlay.classList.add('hidden');
    chestSprite.className = 'chest-sprite';
    chestSprite.src = 'assets/chest_closed.png';
    chestInstruction.classList.add('hidden');

    await sleep(600); 

    // 2. Show glowing chest & wait for tap (or let the student back off)
    chestSprite.src = 'assets/chest_locked_glow.png';
    chestSprite.classList.add('chest-glow-effect');
    chestInstruction.textContent = "TAP untuk BUKA";
    chestInstruction.classList.remove('hidden');

    const chestBackBtn = document.getElementById('chest-back-btn');
    if (chestBackBtn) chestBackBtn.classList.remove('hidden');

    // --- NEW: SHOW RANDOM SUSPENSE TEXT ---
    const suspenseTextEl = document.getElementById('chest-suspense-text');
    if (suspenseTextEl) {
        const randomPhrase = CHEST_SUSPENSE_PHRASES[Math.floor(Math.random() * CHEST_SUSPENSE_PHRASES.length)];
        suspenseTextEl.textContent = randomPhrase;
        suspenseTextEl.classList.add('visible');
    }
    // ---------------------------------------

    const tappedEl = await waitForAny([chestSprite, chestBackBtn]);
    
    // Hide suspense text once they decide
    if (suspenseTextEl) suspenseTextEl.classList.remove('visible');
    if (chestBackBtn) chestBackBtn.classList.add('hidden');
    
    if (tappedEl === chestBackBtn) {
        // Student chose to back off
        chestOverlay.classList.add('hidden');
        resetToScanner();
        return;
    }
        // 3. Shake violently
    chestSprite.classList.remove('chest-glow-effect');
    chestSprite.classList.add('chest-shake-css');
    chestInstruction.classList.add('hidden');
    await sleep(800); 
     // --- NEW: TRIGGER GLOBAL ANNOUNCEMENTS ---
 if (qData.chest_type === 'bomb') {
     await triggerAnnouncement(`💥 ${currentUser.name} Membuka kotak BOMB!`);
 } else if (rarity === 'mythic') {
     await triggerAnnouncement(`💎${currentUser.name} Menemukan harta Mythic!`);
 }
// --- NEW: CHECK FOR HINT ---
 if (qData.chest_type === 'hint') {
     chestOverlay.classList.add('hidden');
     await playHintSequence(qData.text); // qData.text contains the hint info
     return; // STOP HERE! Do not show scroll or parchment.
 }
    // --- NEW: CHECK FOR BOMB ---
    if (qData.chest_type === 'bomb') {
        chestOverlay.classList.add('hidden'); // Hide the chest
        await playBombSequence(); // Play the explosion
        return; // STOP HERE! Do not show the scroll or parchment.
    }
    // ---------------------------

    // 4. Hide Chest, Show FOLDED SCROLL
    chestOverlay.classList.add('hidden');
    scrollOverlay.classList.remove('hidden');

    const foldedScrollSprite = document.getElementById('folded-scroll-sprite');
    await waitForTap(foldedScrollSprite);

        // 5. Hide Folded Scroll, Show UNROLLED PARCHMENT
    scrollOverlay.classList.add('hidden');
    parchmentOverlay.classList.remove('hidden');

    // FIX: Force hide the instruction so it doesn't overlap the question!
    const instructionEl = document.getElementById('parchment-instruction');
    if (instructionEl) instructionEl.classList.add('hidden');

    const parchmentContentEl = document.getElementById('parchment-content');
    parchmentContentEl.classList.add('hidden'); // Hide content initially
    
    // Setup Content
    const rpgRarityBadge = document.getElementById('parchment-rarity-badge');
    rpgRarityBadge.textContent = rarity.toUpperCase();
    const rarityColors = { rare: '#4CAF50', epic: '#9c27b0', legendary: '#ff9800', mythic: '#f44336', common: '#9e9e9e' };
    rpgRarityBadge.style.backgroundColor = rarityColors[rarity] || '#9e9e9e';
    
    const rpgQText = document.getElementById('parchment-q-text');
    rpgQText.textContent = qData.text;
    rpgQText.classList.remove('time-up-text'); // Reset time-up class
    
    renderParchmentOptions(qData);
    startParchmentTimer(rarity);

    // 6. Reveal content with ghost click protection
    await sleep(100); 
    parchmentContentEl.classList.remove('hidden');
    parchmentContentEl.style.pointerEvents = 'none';
    setTimeout(() => { parchmentContentEl.style.pointerEvents = 'auto'; }, 400);
}

function renderParchmentOptions(qData) {
    const rpgQOptions = document.getElementById('parchment-q-options');
    rpgQOptions.innerHTML = '';
    const labels = ['A', 'B', 'C', 'D'];
    qData.options.forEach((opt, index) => {
        if (opt) {
            const btn = document.createElement('button');
            btn.className = 'option-btn';
            btn.textContent = `${labels[index]}. ${opt}`;
            btn.onclick = () => submitAnswer(labels[index], 'parchment');
            rpgQOptions.appendChild(btn);
        }
    });
}

function startParchmentTimer(rarity) {
    const timeLimit = GAME_CONFIG.timeLimits[rarity] || 30000;
    runTimer(timeLimit, '.parchment-timer-bar', '.parchment-timer-text', () => handleTimeUp('parchment'));
}

// ==========================================
// 6. SHARED TIMER & SUBMISSION LOGIC
// ==========================================
function runTimer(timeLimit, barSelector, textSelector, onTimeUpCallback) {
    clearInterval(questionTimerInterval);
    const startTime = Date.now();
    const timerBar = document.querySelector(barSelector);
    const timerText = document.querySelector(textSelector);

    questionTimerInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const remaining = timeLimit - elapsed;
        if (remaining <= 0) {
            clearInterval(questionTimerInterval);
            onTimeUpCallback();
        } else {
            const percent = (remaining / timeLimit) * 100;
            if(timerBar) timerBar.style.width = percent + '%';
            if(timerText) timerText.textContent = Math.ceil(remaining / 1000) + 's';
            if (percent < 30) { if(timerBar) timerBar.style.backgroundColor = '#f44336'; } 
            else if (percent < 60) { if(timerBar) timerBar.style.backgroundColor = '#ff9800'; }
        }
    }, 100);
}

function handleTimeUp(source) {
    clearInterval(questionTimerInterval);
    if (source === 'parchment') {
        const rpgQText = document.getElementById('parchment-q-text');
        const rpgQOptions = document.getElementById('parchment-q-options');
        
        if(rpgQText) {
            rpgQText.textContent = "WAKTU HABIS!";
            rpgQText.classList.add('time-up-text');
        }
        if(rpgQOptions) rpgQOptions.innerHTML = ''; 

        setTimeout(() => {
            resetToScanner();
            if(rpgQText) rpgQText.classList.remove('time-up-text');
        }, 2000);
    }
}

async function submitAnswer(selectedOption, source = 'parchment') {
    clearInterval(questionTimerInterval);
    if (!currentUser || !currentQuestionId) return;
    if (!isGameActive) { showGameOver(); return; }

    const rpgQText = document.getElementById('parchment-q-text');
    const rpgQOptions = document.getElementById('parchment-q-options');
    if(rpgQText) rpgQText.textContent = "Memeriksa jawaban...";
    if(rpgQOptions) rpgQOptions.innerHTML = '';

    // 1. Fetch question data to verify answer and get rarity
    let qData = null;
    try {
        const qRes = await fetch(`${FIREBASE_URL}/questions/${currentQuestionId}.json?auth=${FIREBASE_SECRET}`);
        qData = await qRes.json();
    } catch(e) { console.error("Failed to fetch question", e); }

    const isCorrect = qData && (selectedOption === qData.correct_answer);
    const rarity = qData && qData.rarity ? qData.rarity.toLowerCase().trim() : 'common';
    const basePoints = GAME_CONFIG.rarityPoints[rarity] || 10;

    // 2. Calculate time remaining, then the actual points this answer is
    // worth: base rarity points x speed multiplier x timeout multiplier.
    // This is the single place score gets computed — it's stored on the
    // submission itself so the student's score, the loot drop value, and the
    // teacher leaderboard all read the same number instead of recalculating
    // it three different ways.
    const timerTextEl = document.querySelector('.parchment-timer-text');
    let timeRemaining = 0;
    if (timerTextEl) {
        const secsLeft = parseInt(timerTextEl.textContent.replace('s', ''));
        timeRemaining = (secsLeft || 0) * 1000;
    }
    const timeLimit = GAME_CONFIG.timeLimits[rarity] || 30000;
    const timeouts = currentUser.questionTimeouts[currentQuestionId] || 0;
    const speedMultiplier = getSpeedMultiplier(timeRemaining, timeLimit);
    const timeoutMultiplier = getTimeoutMultiplier(timeouts);
    const pointsEarned = isCorrect ? Math.round(basePoints * speedMultiplier * timeoutMultiplier) : 0;

    // 3. Prepare submission data
    const submissionData = {
        student_password: currentUser.password,
        student_name: currentUser.name,
        student_class: currentUser.class,
        question_id: currentQuestionId,
        selected_answer: selectedOption,
        is_correct: isCorrect, // Helpful for teacher dashboard debugging
        points_earned: pointsEarned, // The actual score this answer is worth
        timestamp: Date.now()
    };

    try {
        const response = await fetch(`${FIREBASE_URL}/submissions.json?auth=${FIREBASE_SECRET}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(submissionData)
        });
        if (!response.ok) throw new Error("Network response was not ok");

        // 4. Update local state
        currentUser.answeredQuestions.add(currentQuestionId);
        currentUser.globalQuestionUses[currentQuestionId] = (currentUser.globalQuestionUses[currentQuestionId] || 0) + 1;
        
        if (isCorrect) {
            currentUser.correctCount++;
            currentUser.rawScore += pointsEarned;
            if (currentUser.answeredRarities[rarity] !== undefined) {
                currentUser.answeredRarities[rarity]++;
            }
        }

        updateProgressTracker();

        // 5. Check if personal hunt is over (handles resolved chests logic)
        if (checkPersonalFinishCondition()) return; 

        // 6. Handle Correct vs Incorrect Visuals
        if (isCorrect) {
            // --- CORRECT ANSWER FLOW ---
            if(rpgQText) {
                rpgQText.textContent = "BENAR!";
                rpgQText.style.color = "#4CAF50"; // Green
            }
            
            // Brief pause to let them see "BENAR!" before the loot drops
            await new Promise(resolve => setTimeout(resolve, 800));
            
            // Trigger Loot Drop (this function shows the modal and waits for "Add to Inventory" click)
            await processLootDrop(timeRemaining, timeLimit, rarity, pointsEarned);
            
            // Note: processLootDrop handles calling resetToScanner() internally, so we return here.
            return;
            
        } else {
            // --- WRONG ANSWER FLOW ---
            if(rpgQText) {
                rpgQText.textContent = "SALAH!";
                rpgQText.style.color = "var(--danger-color)"; // Red
            }
            
            // Screen shake effect
            document.body.classList.add('screen-shake');
            setTimeout(() => document.body.classList.remove('screen-shake'), 500);

            // Wait 1.5 seconds, then reset
            setTimeout(() => { 
                resetToScanner(); 
                if(rpgQText) rpgQText.style.color = "var(--ink-color)"; // Reset color for next time
            }, 1500);
            return;
        }

    } catch (error) {
        console.error("Submission error:", error);
        if(rpgQText) rpgQText.textContent = "Gagal, tap untuk ulangi.";
        if(rpgQOptions) rpgQOptions.innerHTML = `<button class="option-btn" onclick="loadQuestion('${currentQuestionId}')">Retry</button>`;
    }
}

function resetToScanner() {
    feedbackArea.classList.add('hidden');
    questionModal.classList.add('hidden');
    parchmentOverlay.classList.add('hidden');
    chestOverlay.classList.add('hidden');
    scrollOverlay.classList.add('hidden');
    scannerArea.classList.remove('hidden');
    currentQuestionId = null;
    if (qText) qText.style.color = "var(--text-color)";
    clearInterval(questionTimerInterval);
    if (html5QrcodeScanner) html5QrcodeScanner.resume();
}

// ==========================================
// 7. PROGRESS TRACKER & HELPERS
// ==========================================
function updateProgressTracker() {
    if (!currentUser || !progressTracker || !currentUser.questionMaxUses) return;

    let resolvedChests = 0;
    
    // Loop through every question in the database
    for (const [qId, maxUses] of Object.entries(currentUser.questionMaxUses)) {
        const openedByMe = currentUser.answeredQuestions.has(qId);
        const claimedGlobally = (currentUser.globalQuestionUses[qId] || 0) >= maxUses;
        
        // If they opened it, OR someone else already claimed it, it counts as resolved!
        if (openedByMe || claimedGlobally) {
            resolvedChests++;
        }
    }

    const total = currentUser.totalQuestions;
    const percent = total > 0 ? (resolvedChests / total) * 100 : 0;
    const isComplete = resolvedChests >= total && total > 0;

    progressTracker.innerHTML = `
        <div class="progress-header">
            <span>Soal ditemukan</span>
            <span>${resolvedChests} / ${total} Chests</span>
        </div>
        <div class="progress-bar-container ${isComplete ? 'progress-complete' : ''}">
            <div class="progress-bar-fill" style="width: ${percent}%"></div>
        </div>
        ${isComplete ? '<div style="text-align:center; font-weight:bold; color:#FFD700; margin-top:5px;">🏆 ALL CHESTS RESOLVED!</div>' : ''}
    `;
}
function checkPersonalFinishCondition() {
    if (!currentUser || !currentUser.questionMaxUses) return false;

    let resolvedChests = 0;
    for (const [qId, maxUses] of Object.entries(currentUser.questionMaxUses)) {
        const openedByMe = currentUser.answeredQuestions.has(qId);
        const claimedGlobally = (currentUser.globalQuestionUses[qId] || 0) >= maxUses;
        if (openedByMe || claimedGlobally) resolvedChests++;
    }

    if (resolvedChests >= currentUser.totalQuestions && currentUser.totalQuestions > 0) {
        showFinishScreen();
        return true;
    }
    return false;
}
// ==========================================
// BOMB SEQUENCE & PENALTY
// ==========================================
async function playBombSequence() {
    const bombOverlay = document.getElementById('bomb-overlay');
    const bombSprite = document.getElementById('bomb-sprite');
    const bombFlash = document.getElementById('bomb-flash');
    const bombMessage = document.getElementById('bomb-message');

    // 1. Show overlay and start screen shake
    bombOverlay.classList.remove('hidden');
    document.body.classList.add('screen-shake');

    // 2. Play the 4 frames
    bombSprite.src = 'assets/bomb_1.png'; // Lit bomb
    await sleep(800);
    
    bombSprite.src = 'assets/bomb_2.png'; // Sparking
    await sleep(600);

    // 3. The Explosion & Red Flash
    bombSprite.src = 'assets/bomb_3.png'; // White flash frame
    bombFlash.classList.remove('hidden');
    bombFlash.classList.add('flash-active');
    await sleep(200);

    bombSprite.src = 'assets/bomb_4.png'; // Fire explosion
    await sleep(800);

    // 4. Hide sprite, show penalty message
    bombSprite.classList.add('hidden');
    bombMessage.classList.remove('hidden');

         // 5. Record the penalty in Firebase
     await submitBombPenalty();

     // FIX: Update local memory immediately so they can't trigger it again this session!
       // FIX: Update local memory immediately so they can't trigger it again this session!
  currentUser.answeredQuestions.add(currentQuestionId);
  currentUser.globalQuestionUses[currentQuestionId] = (currentUser.globalQuestionUses[currentQuestionId] || 0) + 1;
  
  // NEW: Update progress and check for personal finish
  updateProgressTracker();
  if (checkPersonalFinishCondition()) {
      // If they finished, the resetToScanner() at the bottom of playBombSequence 
      // will be overridden by the finish screen overlay.
  }

    // 6. Wait, then reset
    await sleep(2500);
    
    // Cleanup
    document.body.classList.remove('screen-shake');
    bombOverlay.classList.add('hidden');
    bombSprite.classList.remove('hidden');
    bombMessage.classList.add('hidden');
    bombFlash.classList.remove('flash-active');
    resetToScanner();
}

async function submitBombPenalty() {
    // FIX: Use currentQuestionId so it counts toward max_uses and prevents re-opening!
    const submissionData = {
        student_password: currentUser.password,
        student_name: currentUser.name,
        student_class: currentUser.class,
        question_id: currentQuestionId, // <--- THE FIX: Use the real ID
        selected_answer: 'BOMB',
        is_bomb: true, // <--- Helper flag for the teacher dashboard
        timestamp: Date.now()
    };

    try {
        await fetch(`${FIREBASE_URL}/submissions.json?auth=${FIREBASE_SECRET}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(submissionData)
        });
    } catch (error) { 
        console.error("Bomb penalty submission error:", error); 
    }
}

function waitForTap(element) {
    return new Promise((resolve) => {
        const handler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            element.removeEventListener('click', handler);
            element.removeEventListener('touchstart', handler);
            resolve();
        };
        element.addEventListener('click', handler);
        element.addEventListener('touchstart', handler, { passive: false });
    });
}
async function playHintSequence(hintText) {
    const hintOverlay = document.getElementById('hint-overlay');
    const hintTextEl = document.getElementById('hint-text');
    const hintBackBtn = document.getElementById('hint-back-btn');
    const hintLogoutBtn = document.getElementById('hint-logout-btn');

    // Show overlay and set text
    hintOverlay.classList.remove('hidden');
    if (hintTextEl) hintTextEl.textContent = hintText;

    // Wait for them to tap either "Back to Scanner" or "Return to Login"
    const tappedEl = await waitForAny([hintBackBtn, hintLogoutBtn]);

    // Cleanup
    hintOverlay.classList.add('hidden');

    if (tappedEl === hintLogoutBtn) {
        handleLogout();
    } else {
        resetToScanner();
    }
}

// Races a tap/click across several elements at once (e.g. "chest" vs "back
// button") and resolves with whichever element was actually tapped, cleaning
// up every listener so the losing element doesn't leave a dangling handler.
function waitForAny(elements) {
    return new Promise((resolve) => {
        const entries = elements.filter(Boolean).map((el) => ({ el, handler: null }));
        const cleanup = () => {
            entries.forEach(({ el, handler }) => {
                el.removeEventListener('click', handler);
                el.removeEventListener('touchstart', handler);
            });
        };
        entries.forEach((entry) => {
            entry.handler = (e) => {
                e.preventDefault();
                e.stopPropagation();
                cleanup();
                resolve(entry.el);
            };
            entry.el.addEventListener('click', entry.handler);
            entry.el.addEventListener('touchstart', entry.handler, { passive: false });
        });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// Handle Locked Chest "Back" button
const lockedBackBtn = document.getElementById('locked-back-btn');
if (lockedBackBtn) {
    lockedBackBtn.addEventListener('click', () => {
        document.getElementById('locked-overlay').classList.add('hidden');
        resetToScanner();
    });
}
// ==========================================
// FINISH SCREEN & GLOBAL ANNOUNCEMENTS
// ==========================================

function showFinishScreen() {
    const finishOverlay = document.getElementById('finish-overlay');
    const finishScore = document.getElementById('finish-score');
    const finishAccuracy = document.getElementById('finish-accuracy');
    const finishQuestions = document.getElementById('finish-questions');
    const finishRank = document.getElementById('finish-rank'); // Add this
    const finishLogoutBtn = document.getElementById('finish-logout-btn');

    // Calculate Accuracy
    const accuracy = currentUser.totalQuestions > 0 
        ? Math.round((currentUser.correctCount / currentUser.totalQuestions) * 100) 
        : 0;

    // Calculate Rank
    const maxScore = currentUser.maxPossibleScore || 1;
    const percentage = (currentUser.rawScore / maxScore) * 100;
    
    let rankText = "F-Rank";
    let rankColor = "#f44336";

    if (percentage >= 90) {
        rankText = "🏆 S-Rank";
        rankColor = "#FFD700";
    } else if (percentage >= 80) {
        rankText = " A-Rank";
        rankColor = "#4CAF50";
    } else if (percentage >= 70) {
        rankText = "🥈 B-Rank";
        rankColor = "#2196F3";
    } else if (percentage >= 60) {
        rankText = "🥉 C-Rank";
        rankColor = "#FF9800";
    }

    // Update UI
    if(finishScore) finishScore.textContent = currentUser.rawScore;
    if(finishAccuracy) finishAccuracy.textContent = accuracy + '%';
    if(finishQuestions) finishQuestions.textContent = `${currentUser.answeredQuestions.size} / ${currentUser.totalQuestions}`;
    
    // Update Rank
    if(finishRank) {
        finishRank.textContent = rankText;
        finishRank.style.color = rankColor;
    }

    // Show Overlay
    if(finishOverlay) finishOverlay.classList.remove('hidden');

    // Attach logout event
    if(finishLogoutBtn) {
        finishLogoutBtn.onclick = handleLogout; 
    }
}
// Trigger Global Announcement
async function triggerAnnouncement(message) {
    try {
        // POST (push) instead of PUT so each announcement gets its own entry
        // in the list instead of overwriting the previous one.
        await fetch(`${FIREBASE_URL}/announcements.json?auth=${FIREBASE_SECRET}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                text: message, 
                timestamp: Date.now() 
            })
        });
    } catch (error) { console.error("Announcement error:", error); }
}

// Poll for Announcements every 10 seconds
let announcementInterval = null;
function startAnnouncementPolling() {
    if (announcementInterval) clearInterval(announcementInterval);
    fetchLatestAnnouncement(); // Fetch immediately
    announcementInterval = setInterval(fetchLatestAnnouncement, 10000);
}

async function fetchLatestAnnouncement() {
    try {
        const res = await fetch(`${FIREBASE_URL}/announcements.json?auth=${FIREBASE_SECRET}`);
        const data = await res.json();
        const ticker = document.getElementById('announcement-ticker');
        const tickerText = document.getElementById('announcement-text');

        if (!data) {
            if (ticker) ticker.classList.add('hidden');
            return;
        }

        // Supports both the old single-object format (from before this was a
        // pushed list) and the new format where each announcement is its own
        // child under announcements/.
        const entries = (data.text !== undefined) ? [data] : Object.values(data);
        if (entries.length === 0) {
            if (ticker) ticker.classList.add('hidden');
            return;
        }

        // Newest first
        entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        if (tickerText) tickerText.textContent = entries[0].text;
        if (ticker) ticker.classList.remove('hidden');

        if (announcementHistoryDropdown) {
            announcementHistoryDropdown.innerHTML = entries.slice(0, 20).map(e => {
                const time = e.timestamp
                    ? new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : '';
                return `<div class="announcement-history-item"><span class="announcement-history-time">${time}</span><span>${e.text}</span></div>`;
            }).join('');
        }
    } catch (error) { /* Ignore silent fails */ }
}
// --- SECRET CODE MODAL LOGIC ---
const secretCodeBtn = document.getElementById('secret-code-btn');
const secretCodeModal = document.getElementById('secret-code-modal');
const secretCodeInput = document.getElementById('secret-code-input');
const secretCodeSubmit = document.getElementById('secret-code-submit');
const secretCodeCancel = document.getElementById('secret-code-cancel');

if (secretCodeBtn) {
    secretCodeBtn.addEventListener('click', () => {
        secretCodeModal.classList.remove('hidden');
        secretCodeInput.value = '';
        secretCodeInput.focus();
    });
}
if (secretCodeCancel) {
    secretCodeCancel.addEventListener('click', () => secretCodeModal.classList.add('hidden'));
}
if (secretCodeSubmit) {
    secretCodeSubmit.addEventListener('click', () => {
        const qId = secretCodeInput.value.trim();
        if (qId) {
            secretCodeModal.classList.add('hidden');
            loadQuestion(qId);
        }
    });
}
// Allow pressing "Enter" in the secret code input
if (secretCodeInput) {
    secretCodeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && secretCodeSubmit) secretCodeSubmit.click();
    });
}
// ==========================================
// LOOT DROP & INVENTORY SYSTEM
// ==========================================

// 1. Track Timeouts
const originalHandleTimeUp = handleTimeUp;
handleTimeUp = function(source) {
    // Track timeout for the current question
    if (currentQuestionId) {
        if (!currentUser.questionTimeouts[currentQuestionId]) {
            currentUser.questionTimeouts[currentQuestionId] = 0;
        }
        currentUser.questionTimeouts[currentQuestionId]++;
    }
    // Call the original function
    originalHandleTimeUp(source);
};

// 2. Pick a Loot Item & Show Modal
// Score is calculated once, in submitAnswer, and passed in as pointsEarned —
// this function never touches score. It only decides WHICH item drops:
// each rarity in loot_table.json has its own ordered list of speed
// brackets (e.g. answer with >=75% of the time left -> this item, >=40% ->
// that item, otherwise -> the fallback item), completely independent of how
// score is computed. Changing bracket thresholds or which items sit in them
// never affects scoring, and vice versa.
async function processLootDrop(timeRemaining, timeLimit, questionRarity, pointsEarned) {
    // Nothing to show if this run scored 0 (e.g. 3rd+ timeout on this question)
    if (!pointsEarned || pointsEarned <= 0) {
        resetToScanner();
        return null;
    }

    const timeouts = currentUser.questionTimeouts[currentQuestionId] || 0;
    if (timeouts >= 3) { resetToScanner(); return null; } // Safety net; pointsEarned would already be 0 here

    // How much of the time limit is left, as a fraction (0 = none, 1 = all).
    let speedPercent = timeLimit > 0 ? (timeRemaining / timeLimit) : 0;
    speedPercent = Math.max(0, Math.min(1, speedPercent));

    // window.lootTable should already be populated — core.js awaits
    // lootTableLoaded before login can proceed. This is now only a safety
    // net for a genuinely failed fetch (e.g. bad connection), not the
    // race condition it used to guard against. Retry once before giving up
    // silently, and if it still fails, tell the student instead of just
    // closing — their points are already recorded either way (scoring
    // happens in submitAnswer, independently of the loot table), so this
    // never loses points, only the item pickup.
    let rarityDrops = (window.lootTable || {})[questionRarity];
    if (!rarityDrops || rarityDrops.length === 0) {
        await fetchLootTable();
        rarityDrops = (window.lootTable || {})[questionRarity];
    }
    if (!rarityDrops || rarityDrops.length === 0) {
        alert(`Poin sudah tersimpan (+${pointsEarned}), tapi item loot gagal dimuat. Coba refresh halaman untuk mengambil item berikutnya.`);
        resetToScanner();
        return null;
    }

    // Brackets can be listed in any order in the JSON — sort by minPercent
    // descending and take the first (highest) one the student qualifies
    // for. Falls back to the lowest bracket if somehow none match (e.g. a
    // rarity's brackets don't reach all the way down to 0).
    const sortedDrops = [...rarityDrops].sort((a, b) => b.minPercent - a.minPercent);

    // Prior timeouts on THIS question degrade the reachable bracket: one
    // timeout blocks the top bracket, two forces the bottom one regardless
    // of actual speed. The cap for 1 timeout is the 2nd-highest bracket's
    // own threshold (not a fixed number), so this keeps working correctly
    // no matter how many brackets this rarity has been configured with.
    if (timeouts === 2) speedPercent = 0;
    else if (timeouts === 1 && sortedDrops.length > 1) speedPercent = Math.min(speedPercent, sortedDrops[1].minPercent);

    const drop = sortedDrops.find(d => speedPercent >= d.minPercent) || sortedDrops[sortedDrops.length - 1];
    const itemId = drop.item_id;
    const itemData = drop;

    // Populate the Loot Modal with the score submitAnswer already computed
    document.getElementById('loot-icon').src = `assets/items/${itemId}.png`;
    document.getElementById('loot-title').textContent = itemData.name;
    document.getElementById('loot-desc').textContent = itemData.description;
    document.getElementById('loot-tier').textContent = `${questionRarity.charAt(0).toUpperCase()}${questionRarity.slice(1)} drop`;
    document.getElementById('loot-points').textContent = `+${pointsEarned} Pts`;

    // Show Modal & Handle "Add to Inventory"
    const lootModal = document.getElementById('loot-reveal-modal');
    lootModal.classList.remove('hidden');

    const keepBtn = document.getElementById('loot-keep-btn');
    keepBtn.onclick = async () => {
        const entry = { item_id: itemId, points: pointsEarned };
        currentUser.collectedItems.push(entry);
        lootModal.classList.add('hidden');

        // Persist to Firebase — including the exact points this specific
        // drop was worth — so it survives logout/login instead of only
        // living in the in-memory currentUser object.
        try {
            await fetch(`${FIREBASE_URL}/inventory/${currentUser.password}.json?auth=${FIREBASE_SECRET}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(entry)
            });
        } catch (e) {
            console.error("Failed to save loot item to inventory:", e);
        }

        resetToScanner(); 
    };

    return itemId; 
}

function renderInventoryGrid() {
    const grid = document.getElementById('inventory-grid');
    grid.innerHTML = '';
    const items = currentUser.collectedItems || [];

    // Total value = sum of what every pickup was actually worth (already
    // computed by submitAnswer's speed/timeout multipliers), not the
    // loot_table's flat base_points — those only decide which tier of item
    // can drop, not what it's worth.
    const totalValue = items.reduce((sum, entry) => sum + (entry.points || 0), 0);
    if (inventoryTotalValueEl) inventoryTotalValueEl.textContent = totalValue;

    if (items.length === 0) {
        grid.innerHTML = '<p style="grid-column: 1/-1; color: #666; text-align: center;">Belum ada harta karun!</p>';
        return;
    }

    // Count duplicates and accumulate the real value earned per item type
    const itemCounts = {};
    const itemValues = {};
    items.forEach(entry => {
        itemCounts[entry.item_id] = (itemCounts[entry.item_id] || 0) + 1;
        itemValues[entry.item_id] = (itemValues[entry.item_id] || 0) + (entry.points || 0);
    });

    for (const [itemId, count] of Object.entries(itemCounts)) {
        const item = (window.lootItemsById || {})[itemId];
        if (!item) continue;

        const slot = document.createElement('div');
        slot.className = 'loot-slot';
        slot.innerHTML = `
            <img src="assets/items/${itemId}.png" alt="${item.name}">
            <span class="loot-count">x${count}</span>
        `;
        
        slot.addEventListener('click', () => {
            document.getElementById('detail-icon').src = `assets/items/${itemId}.png`;
            document.getElementById('detail-title').textContent = item.name;
            document.getElementById('detail-desc').textContent = item.description;
            document.getElementById('detail-tier').textContent = `${item.rarity.charAt(0).toUpperCase()}${item.rarity.slice(1)} drop`;
            document.getElementById('detail-points').textContent = `Value: ${itemValues[itemId]} Pts`;
            if (itemDetailModal) itemDetailModal.classList.remove('hidden');
        });
        grid.appendChild(slot);
    }
}

// 3. Open/Close the Inventory Modal
if (openInventoryBtn) {
    openInventoryBtn.addEventListener('click', () => {
        if (!currentUser) return;
        renderInventoryGrid();
        if (inventoryModal) inventoryModal.classList.remove('hidden');
    });
}
if (closeInventoryBtn) {
    closeInventoryBtn.addEventListener('click', () => {
        if (inventoryModal) inventoryModal.classList.add('hidden');
    });
}
if (inventoryBackScannerBtn) {
    inventoryBackScannerBtn.addEventListener('click', () => {
        if (inventoryModal) inventoryModal.classList.add('hidden');
    });
}
if (closeDetailBtn) {
    closeDetailBtn.addEventListener('click', () => {
        if (itemDetailModal) itemDetailModal.classList.add('hidden');
    });
}
