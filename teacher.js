// ==========================================
// 1. CONFIGURATION & SAFE DOM ELEMENTS
// ==========================================
const EXPORT_API_URL = 'https://script.google.com/macros/s/AKfycbyyfXoe7tzhnyGy17O5azHjoS8eVDfP7oh4UXiuX41rxnfo-f2FgX_Mb-cPEYdnejYZwg/exec';

// Safety net: if core.js on this page is an older/out-of-sync version that
// doesn't define GAME_CONFIG / gameConfigLoaded yet, fall back to built-in
// defaults here instead of throwing and breaking the whole dashboard. (This
// should normally never trigger — it just means core.js and teacher.js got
// deployed out of sync. Make sure you upload the matching set of files.)
if (typeof GAME_CONFIG === 'undefined') {
    console.warn("GAME_CONFIG is missing — core.js may be out of date. Using built-in fallback defaults.");
    window.GAME_CONFIG = {
        rarityPoints: { common: 10, rare: 25, epic: 50, legendary: 100, mythic: 250 },
        timeLimits: { common: 30000, rare: 20000, epic: 15000, legendary: 10000, mythic: 5000 },
        speedThresholds: [
            { minPercent: 0.833, multiplier: 1.0 },
            { minPercent: 0.333, multiplier: 0.7 },
            { minPercent: 0,     multiplier: 0.5 }
        ],
        timeoutMultipliers: { 0: 1.0, 1: 0.7, 2: 0.5 },
        bombPenalty: 30
    };
}
if (typeof gameConfigLoaded === 'undefined') {
    window.gameConfigLoaded = Promise.resolve();
}

// Helper to safely get elements (prevents crashes if ID is missing)
const getEl = (id) => document.getElementById(id);

const gameDurationInput = getEl('game-duration');
const startGameBtn = getEl('start-game-btn');
const stopGameBtn = getEl('stop-game-btn');
const gameStatusText = getEl('game-status-text');
const refreshScoresBtn = getEl('refresh-scores-btn');
const leaderboardBody = getEl('leaderboard-body');
const purgeSubmissionsBtn = getEl('purge-submissions-btn');
const exportSheetsBtn = getEl('export-sheets-btn');
const saveConfigBtn = getEl('save-config-btn');
const configSaveStatus = getEl('config-save-status');
const configLockNotice = getEl('config-lock-notice');
const speedThresholdsList = getEl('speed-thresholds-list');
const addSpeedThresholdBtn = getEl('add-speed-threshold-btn');

let currentLeaderboardData = [];
let currentMaxScore = 0;

// ==========================================
// 2. TAB SWITCHING LOGIC (FIXES THE TABS)
// ==========================================
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
        // Remove active classes from all buttons and contents
        tabBtns.forEach(b => b.classList.remove('active-tab'));
        tabContents.forEach(c => c.classList.remove('active-tab-content'));
        
        // Add active classes to clicked button and its target content
        btn.classList.add('active-tab');
        const targetId = btn.getAttribute('data-tab');
        const targetContent = document.getElementById(targetId);
        if (targetContent) targetContent.classList.add('active-tab-content');

        // Re-check game status when opening the config tab, so the lock
        // reflects reality even if the game was started/stopped from
        // another tab or device since this dashboard last loaded.
        if (targetId === 'tab-config') {
            await checkTeacherGameStatus();
            populateConfigForm();
            updateConfigLockState(isGameActive);
        }
    });
});

// ==========================================
// 3. TEACHER DASHBOARD INIT & STATUS
// ==========================================
async function loadTeacherDashboard() {
    await checkTeacherGameStatus();
    calculateAndRenderLeaderboard();
    await gameConfigLoaded;
    populateConfigForm();
    updateConfigLockState(isGameActive);
}

async function checkTeacherGameStatus() {
    if (!gameStatusText) return;
    try {
        const response = await fetch(`${FIREBASE_URL}/gameSettings.json?auth=${FIREBASE_SECRET}`);
        const settings = await response.json();
        if (settings && settings.isActive) {
            const now = Date.now();
            if (now < settings.endTime) {
                const minsLeft = Math.ceil((settings.endTime - now) / 60000);
                gameStatusText.textContent = `🟢 Game Berjalan. Time remaining: ~${minsLeft} mins.`;
                gameStatusText.style.color = "green";
                isGameActive = true;
            } else {
                gameStatusText.textContent = `🔴 Game berakhir (Waktu habis).`;
                gameStatusText.style.color = "red";
                isGameActive = false;
            }
        } else {
            gameStatusText.textContent = `🔴 Game berhenti.`;
            gameStatusText.style.color = "red";
            isGameActive = false;
        }
    } catch (error) { gameStatusText.textContent = " Could not fetch game status."; }
}

// ==========================================
// 4. GAME CONTROLS
// ==========================================
if (startGameBtn) {
    startGameBtn.addEventListener('click', async () => {
        const duration = parseInt(gameDurationInput.value);
        if (!duration || duration < 1) return alert("Please enter a valid duration.");
        const now = Date.now();
        const settings = { isActive: true, durationMinutes: duration, startTime: now, endTime: now + (duration * 60 * 1000) };
        await fetch(`${FIREBASE_URL}/gameSettings.json?auth=${FIREBASE_SECRET}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings)
        });
        alert("Game Started!");
        await checkTeacherGameStatus();
        updateConfigLockState(isGameActive);
    });
}

if (stopGameBtn) {
    stopGameBtn.addEventListener('click', async () => {
        if (!confirm("End game early?")) return;
        await fetch(`${FIREBASE_URL}/gameSettings.json?auth=${FIREBASE_SECRET}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: false })
        });
        alert("Game Ended.");
        await checkTeacherGameStatus();
        updateConfigLockState(isGameActive);
    });
}

// ==========================================
// 5. DYNAMIC ARCADE SCORING & LEADERBOARD
// ==========================================
if (refreshScoresBtn) refreshScoresBtn.addEventListener('click', calculateAndRenderLeaderboard);

async function calculateAndRenderLeaderboard() {
    if (!leaderboardBody) return;
    leaderboardBody.innerHTML = "<tr><td colspan='6'>Calculating scores...</td></tr>";
    await gameConfigLoaded; // safety net — already loaded by the time login gets here

    try {
        const [studentsRes, questionsRes, submissionsRes] = await Promise.all([
            fetch(`${FIREBASE_URL}/students.json?auth=${FIREBASE_SECRET}`).then(r => r.json()),
            fetch(`${FIREBASE_URL}/questions.json?auth=${FIREBASE_SECRET}`).then(r => r.json()),
            fetch(`${FIREBASE_URL}/submissions.json?auth=${FIREBASE_SECRET}`).then(r => r.json())
        ]);

        const students = studentsRes || {};
        const questions = questionsRes || {};
        const submissions = submissionsRes ? Object.values(submissionsRes) : [];

             // 1. Calculate Max Score (Skipping Bombs and Hints)
     let maxPossibleScore = 0;
     for (const qId in questions) {
         const q = questions[qId];
         // Skip optional chests so they don't inflate the max possible score
         if (q && (q.chest_type === 'bomb' || q.chest_type === 'hint')) continue; 
         const rarity = q.rarity ? q.rarity.toLowerCase().trim() : 'common';
         maxPossibleScore += (GAME_CONFIG.rarityPoints[rarity] || 10);
     }
        if (maxPossibleScore === 0) maxPossibleScore = 1; 
        currentMaxScore = maxPossibleScore;

        // 2. Initialize Scores
        const scores = {};
        for (const [password, data] of Object.entries(students)) {
            scores[password] = { name: data.name, class: data.class, rawScore: 0, questionsAnswered: new Set() };
        }

        // 3. Grade Submissions
        submissions.forEach(sub => {
            const qId = sub.question_id;
            const studentPwd = sub.student_password;
            if (!scores[studentPwd]) return; 

            const question = questions[qId]; // may be undefined if the question was deleted/edited after the submission was made

            // Bomb Logic
            if (qId === 'BOMB_TRAP' || (question && question.chest_type === 'bomb')) {
                if (!scores[studentPwd].questionsAnswered.has(qId)) {
                    scores[studentPwd].questionsAnswered.add(qId);
                    scores[studentPwd].rawScore -= GAME_CONFIG.bombPenalty;
                }
                return;
            }

            // Hint chests award no points and shouldn't affect scoring
            if (question && question.chest_type === 'hint') return;

            // Skip orphaned submissions that no longer point to a real question
            if (!question) return;

            // Normal Logic
            if (!scores[studentPwd].questionsAnswered.has(qId)) {
                scores[studentPwd].questionsAnswered.add(qId);
                if (sub.selected_answer === question.correct_answer) {
                    // Use the score recorded on the submission itself (base
                    // rarity points x speed/timeout multipliers) so this always
                    // matches what the student actually earned. Older
                    // submissions made before scoring was recorded fall back
                    // to flat rarity points.
                    const rarity = question.rarity ? question.rarity.toLowerCase().trim() : 'common';
                    scores[studentPwd].rawScore += (typeof sub.points_earned === 'number' ? sub.points_earned : (GAME_CONFIG.rarityPoints[rarity] || 10));
                }
            }
        });

        // 4. Calculate Ranks
        const leaderboard = Object.values(scores).map(s => {
            const percentage = (s.rawScore / maxPossibleScore) * 100;
            let rank = "Parah";
            if (percentage >= 90) rank = "🏆 Super";
            else if (percentage >= 80) rank = "A-Rank";
            else if (percentage >= 70) rank = "B-Rank";
            else if (percentage >= 60) rank = "C-Rank";
            return { ...s, questionsAnswered: s.questionsAnswered.size, percentage: percentage.toFixed(1), rank: rank };
        }).sort((a, b) => b.rawScore - a.rawScore);

        // 5. Save for Export
        currentLeaderboardData = leaderboard.map((s, i) => ({
            rank_num: `#${i + 1}`, name: s.name, class: s.class,
            raw_score: `${s.rawScore} / ${maxPossibleScore}`, percentage: `${s.percentage}%`, arcade_rank: s.rank
        }));

        // 6. Render
        if (leaderboard.length === 0) {
            leaderboardBody.innerHTML = "<tr><td colspan='6'>tidak ada siswa.</td></tr>";
            return;
        }
        leaderboardBody.innerHTML = leaderboard.map((s, i) => `
            <tr>
                <td>#${i + 1}</td><td>${s.name}</td><td>${s.class}</td>
                <td>${s.rawScore} / ${maxPossibleScore}</td>
                <td><strong>${s.percentage}%</strong></td>
                <td style="font-weight: bold; color: ${s.percentage >= 60 ? '#4CAF50' : '#f44336'};">${s.rank}</td>
            </tr>
        `).join('');

    } catch (error) {
        console.error("Leaderboard error:", error);
        leaderboardBody.innerHTML = "<tr><td colspan='6' style='color:red;'>Error loading scores.</td></tr>";
    }
}

// ==========================================
// 6. EXPORT & PURGE (Safe Event Listeners)
// ==========================================
if (exportSheetsBtn) {
    exportSheetsBtn.addEventListener('click', async () => {
        if (currentLeaderboardData.length === 0) return alert("Tidak ada data untuk export, refresh dulu.");
        const sessionName = prompt("Export name:", "Quiz Session");
        if (!sessionName) return;
        exportSheetsBtn.textContent = "Exporting..."; exportSheetsBtn.disabled = true;
        try {
            await fetch(EXPORT_API_URL, {
                method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionName, leaderboard: currentLeaderboardData })
            });
            alert(`✅ Exported ${currentLeaderboardData.length} students!`);
        } catch (error) { alert("❌ Export failed."); }
        finally { exportSheetsBtn.textContent = " Export to Sheets"; exportSheetsBtn.disabled = false; }
    });
}

if (purgeSubmissionsBtn) {
    purgeSubmissionsBtn.addEventListener('click', async () => {
        if (!confirm("⚠️ WARNING: Delete ALL answers? This cannot be undone.")) return;
        purgeSubmissionsBtn.textContent = "Clearing..."; purgeSubmissionsBtn.disabled = true;
        try {
            await Promise.all([
                fetch(`${FIREBASE_URL}/submissions.json?auth=${FIREBASE_SECRET}`, { method: 'DELETE' }),
                fetch(`${FIREBASE_URL}/announcements.json?auth=${FIREBASE_SECRET}`, { method: 'DELETE' }),
                fetch(`${FIREBASE_URL}/inventory.json?auth=${FIREBASE_SECRET}`, { method: 'DELETE' })
            ]);
            alert("✅ Answers & announcements cleared!"); calculateAndRenderLeaderboard();
        } catch (error) { alert("❌ Failed to clear."); }
        finally { purgeSubmissionsBtn.textContent = "Hapus semua jawaban"; purgeSubmissionsBtn.disabled = false; }
    });
}
// ==========================================
// 7. GAME RULES EDITOR (writes /config in Firebase)
// ==========================================
// Values here become GAME_CONFIG for every student (see core.js). Locked
// while a game is in progress: changing rarity points or time limits
// mid-session would mean some students played under the old rules and
// others under the new ones on the same leaderboard, and a student already
// logged in wouldn't pick up the change until they log out/in anyway (see
// core.js — config is fetched once at login). Safer to require the game be
// stopped first.

function populateConfigForm() {
    if (!getEl('cfg-points-common')) return; // config tab not present in this HTML build

    getEl('cfg-points-common').value = GAME_CONFIG.rarityPoints.common;
    getEl('cfg-points-rare').value = GAME_CONFIG.rarityPoints.rare;
    getEl('cfg-points-epic').value = GAME_CONFIG.rarityPoints.epic;
    getEl('cfg-points-legendary').value = GAME_CONFIG.rarityPoints.legendary;
    getEl('cfg-points-mythic').value = GAME_CONFIG.rarityPoints.mythic;

    getEl('cfg-time-common').value = GAME_CONFIG.timeLimits.common / 1000;
    getEl('cfg-time-rare').value = GAME_CONFIG.timeLimits.rare / 1000;
    getEl('cfg-time-epic').value = GAME_CONFIG.timeLimits.epic / 1000;
    getEl('cfg-time-legendary').value = GAME_CONFIG.timeLimits.legendary / 1000;
    getEl('cfg-time-mythic').value = GAME_CONFIG.timeLimits.mythic / 1000;

    renderSpeedThresholdRows(GAME_CONFIG.speedThresholds);

    getEl('cfg-timeout-0').value = GAME_CONFIG.timeoutMultipliers[0];
    getEl('cfg-timeout-1').value = GAME_CONFIG.timeoutMultipliers[1];
    getEl('cfg-timeout-2').value = GAME_CONFIG.timeoutMultipliers[2];

    getEl('cfg-bomb-penalty').value = GAME_CONFIG.bombPenalty;
}

// ==========================================
// SPEED THRESHOLDS — dynamic tier rows
// ==========================================
// GAME_CONFIG.speedThresholds is an array of { minPercent, multiplier }
// tiers, any length (see core.js). This renders one row per tier instead
// of fixed "fast/medium" fields, so the teacher can add or remove tiers —
// 2, 3, 5, however many — and the game (student.js) automatically scores
// against however many tiers are actually saved.

function createSpeedThresholdRow(minPercent, multiplier) {
    const row = document.createElement('div');
    row.className = 'speed-threshold-row';
    row.style.cssText = 'display:flex; gap:10px; align-items:flex-end; margin-bottom:8px;';
    row.innerHTML = `
        <label style="flex:1;">% waktu tersisa min.
            <input type="number" class="cfg-speed-minpercent" step="0.01" min="0" max="1" value="${minPercent}">
        </label>
        <label style="flex:1;">Multiplier
            <input type="number" class="cfg-speed-multiplier" step="0.01" min="0" value="${multiplier}">
        </label>
        <button type="button" class="btn-logout btn-remove-tier" style="padding:8px 14px; width:auto;" title="Hapus tier ini">✕</button>
    `;
    row.querySelector('.btn-remove-tier').addEventListener('click', () => {
        // Always keep at least one tier — with zero rows nothing would
        // ever match a speedPercent and getSpeedMultiplier would break.
        if (speedThresholdsList.querySelectorAll('.speed-threshold-row').length > 1) {
            row.remove();
        } else if (configSaveStatus) {
            configSaveStatus.style.color = "var(--danger-color)";
            configSaveStatus.textContent = "⚠️ Minimal harus ada 1 tier kecepatan.";
        }
    });
    return row;
}

function renderSpeedThresholdRows(thresholds) {
    if (!speedThresholdsList) return; // config tab not present in this HTML build
    speedThresholdsList.innerHTML = '';
    const sorted = [...(thresholds || [])].sort((a, b) => b.minPercent - a.minPercent);
    (sorted.length > 0 ? sorted : [{ minPercent: 0, multiplier: 1.0 }])
        .forEach(t => speedThresholdsList.appendChild(createSpeedThresholdRow(t.minPercent, t.multiplier)));
}

// Reads whatever rows currently exist in the form (including ones the
// teacher just added/removed) back out as a plain array, and guarantees a
// floor tier (minPercent: 0) is always included even if the teacher never
// added one — otherwise a fast answer near the very end of time could fail
// to match any tier at all.
function readSpeedThresholdRows() {
    if (!speedThresholdsList) return GAME_CONFIG.speedThresholds;
    const rows = [...speedThresholdsList.querySelectorAll('.speed-threshold-row')];
    const tiers = rows.map(row => ({
        minPercent: Number(row.querySelector('.cfg-speed-minpercent').value) || 0,
        multiplier: Number(row.querySelector('.cfg-speed-multiplier').value) || 0
    }));
    if (!tiers.some(t => t.minPercent <= 0)) {
        const lowest = tiers.reduce((min, t) => (t.minPercent < min.minPercent ? t : min), tiers[0]);
        tiers.push({ minPercent: 0, multiplier: lowest ? lowest.multiplier : 0.5 });
    }
    return tiers;
}

if (addSpeedThresholdBtn) {
    addSpeedThresholdBtn.addEventListener('click', () => {
        if (speedThresholdsList) speedThresholdsList.appendChild(createSpeedThresholdRow(0.5, 0.8));
    });
}

function updateConfigLockState(locked) {
    document.querySelectorAll('#tab-config input, #tab-config button').forEach(input => { input.disabled = locked; });
    if (saveConfigBtn) saveConfigBtn.disabled = locked;
    if (configLockNotice) configLockNotice.classList.toggle('hidden', !locked);
    if (!locked && configSaveStatus) configSaveStatus.textContent = '';
}

// Re-fetches game status fresh rather than trusting the cached isGameActive
// var, since the teacher could have started the game from a different
// device/tab a moment ago. Fails "locked" if the check itself fails, so a
// network hiccup can't accidentally let a write through.
async function isGameCurrentlyActive() {
    try {
        const res = await fetch(`${FIREBASE_URL}/gameSettings.json?auth=${FIREBASE_SECRET}`);
        const settings = await res.json();
        if (!settings || !settings.isActive) return false;
        return Date.now() < settings.endTime;
    } catch (error) {
        console.error("Could not verify game status before saving config:", error);
        return true; // fail safe: block the write if we're not sure
    }
}

if (saveConfigBtn) {
    saveConfigBtn.addEventListener('click', async () => {
        saveConfigBtn.disabled = true;
        saveConfigBtn.textContent = "Checking...";

        const active = await isGameCurrentlyActive();
        if (active) {
            isGameActive = true;
            updateConfigLockState(true);
            if (configSaveStatus) {
                configSaveStatus.style.color = "var(--danger-color)";
                configSaveStatus.textContent = "⚠️ Game sedang berjalan — hentikan dulu untuk mengubah aturan.";
            }
            saveConfigBtn.textContent = "💾 Simpan Aturan";
            return;
        }

        const newConfig = {
            rarityPoints: {
                common: Number(getEl('cfg-points-common').value) || 10,
                rare: Number(getEl('cfg-points-rare').value) || 25,
                epic: Number(getEl('cfg-points-epic').value) || 50,
                legendary: Number(getEl('cfg-points-legendary').value) || 100,
                mythic: Number(getEl('cfg-points-mythic').value) || 250
            },
            timeLimits: {
                common: (Number(getEl('cfg-time-common').value) || 30) * 1000,
                rare: (Number(getEl('cfg-time-rare').value) || 20) * 1000,
                epic: (Number(getEl('cfg-time-epic').value) || 15) * 1000,
                legendary: (Number(getEl('cfg-time-legendary').value) || 10) * 1000,
                mythic: (Number(getEl('cfg-time-mythic').value) || 5) * 1000
            },
            speedThresholds: readSpeedThresholdRows(),
            timeoutMultipliers: {
                0: Number(getEl('cfg-timeout-0').value),
                1: Number(getEl('cfg-timeout-1').value),
                2: Number(getEl('cfg-timeout-2').value)
            },
            bombPenalty: Number(getEl('cfg-bomb-penalty').value) || 30
        };

        saveConfigBtn.textContent = "Menyimpan...";
        try {
            await fetch(`${FIREBASE_URL}/config.json?auth=${FIREBASE_SECRET}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newConfig)
            });
            GAME_CONFIG = newConfig; // reflect immediately in this tab too
            if (configSaveStatus) {
                configSaveStatus.style.color = "#4CAF50";
                configSaveStatus.textContent = "✅ Aturan tersimpan.";
            }
        } catch (error) {
            console.error("Failed to save config:", error);
            if (configSaveStatus) {
                configSaveStatus.style.color = "var(--danger-color)";
                configSaveStatus.textContent = "❌ Gagal menyimpan aturan.";
            }
        } finally {
            saveConfigBtn.disabled = false;
            saveConfigBtn.textContent = "💾 Simpan Aturan";
        }
    });
}