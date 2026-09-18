// ==========================================
// 1. CONFIGURATION & SAFE DOM ELEMENTS
// ==========================================
const EXPORT_API_URL = 'https://script.google.com/macros/s/AKfycbyyfXoe7tzhnyGy17O5azHjoS8eVDfP7oh4UXiuX41rxnfo-f2FgX_Mb-cPEYdnejYZwg/exec';

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

let currentLeaderboardData = [];
let currentMaxScore = 0;

// ==========================================
// 2. TAB SWITCHING LOGIC (FIXES THE TABS)
// ==========================================
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        // Remove active classes from all buttons and contents
        tabBtns.forEach(b => b.classList.remove('active-tab'));
        tabContents.forEach(c => c.classList.remove('active-tab-content'));
        
        // Add active classes to clicked button and its target content
        btn.classList.add('active-tab');
        const targetId = btn.getAttribute('data-tab');
        const targetContent = document.getElementById(targetId);
        if (targetContent) targetContent.classList.add('active-tab-content');
    });
});

// ==========================================
// 3. TEACHER DASHBOARD INIT & STATUS
// ==========================================
function loadTeacherDashboard() {
    checkTeacherGameStatus();
    calculateAndRenderLeaderboard();
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
        alert("Game Started!"); checkTeacherGameStatus();
    });
}

if (stopGameBtn) {
    stopGameBtn.addEventListener('click', async () => {
        if (!confirm("End game early?")) return;
        await fetch(`${FIREBASE_URL}/gameSettings.json?auth=${FIREBASE_SECRET}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: false })
        });
        alert("Game Ended."); checkTeacherGameStatus();
    });
}

// ==========================================
// 5. DYNAMIC ARCADE SCORING & LEADERBOARD
// ==========================================
if (refreshScoresBtn) refreshScoresBtn.addEventListener('click', calculateAndRenderLeaderboard);

async function calculateAndRenderLeaderboard() {
    if (!leaderboardBody) return;
    leaderboardBody.innerHTML = "<tr><td colspan='6'>Calculating scores...</td></tr>";
    const RARITY_POINTS = { common: 10, rare: 25, epic: 50, legendary: 100, mythic: 250 };

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
         maxPossibleScore += (RARITY_POINTS[rarity] || 10);
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
                    scores[studentPwd].rawScore -= 30;
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
                    const rarity = question.rarity ? question.rarity.toLowerCase().trim() : 'common';
                    scores[studentPwd].rawScore += (RARITY_POINTS[rarity] || 10);
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
