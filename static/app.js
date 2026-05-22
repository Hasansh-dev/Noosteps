window.onerror = function(msg, url, line, col, error) {
  document.body.innerHTML += "<div style='color:red; font-size: 30px; position:absolute; z-index:9999; top:0; left:0; background:white; border: 5px solid red; padding: 20px;'>ERROR: " + msg + "<br>Line: " + line + "</div>";
};

// Fetch Interceptor for Profile Routing
const originalFetch = window.fetch;
window.fetch = async function(...args) {
    let [resource, config] = args;
    const profileId = localStorage.getItem('activeProfileId') || '1';
    
    if (typeof resource === 'string' || resource instanceof URL) {
        config = config || {};
        if (config.headers instanceof Headers) {
            config.headers.append('X-Profile-ID', profileId);
        } else {
            config.headers = config.headers || {};
            config.headers['X-Profile-ID'] = profileId;
        }
        return originalFetch(resource, config);
    } else if (resource instanceof Request) {
        resource.headers.set('X-Profile-ID', profileId);
        return originalFetch(resource, config);
    }
    return originalFetch(...args);
};
// State
const state = {
  activePage: 'dashboard',
  timer: {
    mode: 'pomodoro', // pomodoro, short, long
    timeLeft: 25 * 60,
    isRunning: false,
    interval: null,
    sessionsCompleted: 0,
    focusTimeToday: 0,
    isLockedBreak: false
  },
  notes: [],
  subjects: [],
  subjectFilter: 'all',
  sessions: [],
  profile: { id: 1, name: 'Student', email: '', institution: '', bio: '', level: 'Beginner', goal: 'Learn and grow', avatar_color: '#7c3aed' },
  allProfiles: [],
  streak: 5
};

// DOM Elements
const sidebar = document.getElementById('sidebar');
const pages = document.querySelectorAll('.page');
const navItems = document.querySelectorAll('.nav-item');
const pageTitle = document.getElementById('pageTitle');
const pageSubtitle = document.getElementById('pageSubtitle');

// Timer Elements
const timerDisplay = document.getElementById('timerDisplay');
const timerStartStop = document.getElementById('timerStartStop');
const timerIcon = document.getElementById('timerIcon');
const timerReset = document.getElementById('timerReset');
const timerSkip = document.getElementById('timerSkip');
const timerRingCircle = document.getElementById('timerRingCircle');
const timerTabs = document.querySelectorAll('.timer-tab');
const timerLabel = document.getElementById('timerLabel');

// Initialization
function init() {
  setupNavigation();
  updateDashboardStats();
  setupTimer();
  setupPlanner();
  setupNotes();
  setupModals();
  renderBars();
  setupTutor();
  fetchInsight();
  setupSubjects();
  setupSchedule();
  setupSearch();
  setupNotifications();
  setupProfile();
}

// Navigation
function setupNavigation() {
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const pageId = item.getAttribute('data-page');
      navigateTo(pageId);
    });
  });
}

function navigateTo(pageId) {
  // Update nav state
  navItems.forEach(nav => nav.classList.remove('active'));
  const navEl = document.getElementById(`nav-${pageId}`);
  if (navEl) navEl.classList.add('active');

  // Update page visibility
  pages.forEach(page => page.classList.remove('active'));
  const pageEl = document.getElementById(`page-${pageId}`);
  if (pageEl) pageEl.classList.add('active');
  else return; // bail if page doesn't exist

  // Update Topbar titles
  const titles = {
    'dashboard': { title: 'Dashboard', sub: 'Your AI-powered study command center' },
    'ai-planner': { title: 'AI Planner', sub: 'Generate personalized study paths' },
    'subjects': { title: 'Subjects', sub: 'Manage your curriculum' },
    'schedule': { title: 'Schedule', sub: 'Your timeline for success' },
    'timer': { title: 'Focus Timer', sub: 'Stay in the zone with Pomodoro' },
    'content': { title: 'Content Hub', sub: 'AI-generated deep-dive content powered by Wikipedia + Groq' },
    'notes': { title: 'Notes', sub: 'Capture and organize your thoughts' },
    'ai-tutor': { title: 'AI Tutor', sub: 'Your personal 24/7 learning assistant' },
    'agent-hub': { title: 'Agent Hub', sub: 'Autonomous orchestrator — runs 24/7 without you' },
  };

  pageTitle.textContent = titles[pageId]?.title || pageId;
  pageSubtitle.textContent = titles[pageId]?.sub || '';
  state.activePage = pageId;
  
  if (pageId === 'content') { renderContentSubjectList(); }
  if (pageId === 'agent-hub') refreshAgentHub();
}

// Global navigate function for inline onclick
window.navigateTo = navigateTo;

// Timer Logic
function setupTimer() {
  timerStartStop.addEventListener('click', toggleTimer);
  timerReset.addEventListener('click', resetTimer);
  timerSkip.addEventListener('click', skipTimer);

  timerTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      timerTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      setTimerMode(tab.getAttribute('data-mode'));
    });
  });
  
  updateTimerDisplay();
  renderPomodoroDots();
}

function populateTimerSubjects() {
  const select = document.getElementById('timerSubject');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">Select subject...</option>';
  state.subjects.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    if (String(s.id) === String(current)) opt.selected = true;
    select.appendChild(opt);
  });
}

function setTimerMode(mode) {
  state.timer.mode = mode;
  state.timer.isRunning = false;
  clearInterval(state.timer.interval);
  
  if (mode === 'pomodoro') {
    state.timer.timeLeft = 25 * 60;
    timerLabel.textContent = 'Focus Time';
  } else if (mode === 'short') {
    state.timer.timeLeft = 5 * 60;
    timerLabel.textContent = 'Short Break';
  } else if (mode === 'long') {
    state.timer.timeLeft = 15 * 60;
    timerLabel.textContent = 'Long Break';
  }
  
  updateTimerDisplay();
  updatePlayButton(false);
}

function toggleTimer() {
  if (state.timer.isRunning) {
    clearInterval(state.timer.interval);
    state.timer.isRunning = false;
    updatePlayButton(false);
  } else {
    state.timer.isRunning = true;
    updatePlayButton(true);
    state.timer.interval = setInterval(() => {
      state.timer.timeLeft--;
      if (state.timer.timeLeft < 0) {
        completeTimerSession();
      } else {
        updateTimerDisplay();
      }
    }, 1000);
  }
  // Sync the persistent floating widget
  updateFloatingTimerWidget();
}

function resetTimer() {
  setTimerMode(state.timer.mode);
}

function skipTimer() {
  completeTimerSession();
}

function completeTimerSession() {
  clearInterval(state.timer.interval);
  state.timer.isRunning = false;
  updatePlayButton(false);
  
  if (state.timer.mode === 'pomodoro') {
    state.timer.sessionsCompleted++;
    state.timer.focusTimeToday += 25;
    document.getElementById('ssCompleted').textContent = state.timer.sessionsCompleted;
    document.getElementById('ssFocusTime').textContent = state.timer.focusTimeToday + 'm';
    renderPomodoroDots();
    showToast('Focus session completed! Great job.', 'success');
    
    // ── ACTIVATE POMODORO BREAK LOCK SCREEN ──
    state.timer.isLockedBreak = true;
    
    // Automatically trigger 'short' break mode tab (switches mode to 'short' and 5 min)
    document.getElementById('tab-short').click();
    
    // Render and launch the full-screen blurred lock overlay
    showPomodoroBreakLockOverlay();
    
    // Automatically start the 5-minute break timer countdown immediately!
    toggleTimer();
  } else {
    // ── DISMISS BREAK LOCK SCREEN & LOOP NEXT FOCUS SESSION ──
    if (state.timer.isLockedBreak) {
      state.timer.isLockedBreak = false;
      hidePomodoroBreakLockOverlay();
    }
    
    showToast('Break is over. Back to focus!', 'info');
    
    // Automatically trigger 'pomodoro' focus mode tab (switches mode to 'pomodoro' and 25 min)
    document.getElementById('tab-pomodoro').click();
    
    // Automatically start the next 25-minute study focus session running immediately!
    toggleTimer();
  }
}

function updateTimerDisplay() {
  const m = Math.floor(state.timer.timeLeft / 60);
  const s = state.timer.timeLeft % 60;
  timerDisplay.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  
  // Update Ring
  const total = state.timer.mode === 'pomodoro' ? 25*60 : (state.timer.mode === 'short' ? 5*60 : 15*60);
  const progress = state.timer.timeLeft / total;
  const dashoffset = 753.98 * (1 - progress);
  timerRingCircle.style.strokeDashoffset = dashoffset;

  // Sync floating widget and break overlay displays
  updateFloatingTimerWidget();
  if (state.timer.isLockedBreak) {
    updateLockOverlayDisplay();
  }
}

function updatePlayButton(isPlaying) {
  if (isPlaying) {
    timerIcon.innerHTML = `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`; // Pause icon
  } else {
    timerIcon.innerHTML = `<path d="M8 5v14l11-7L8 5z"/>`; // Play icon
  }
}

function renderPomodoroDots() {
  const container = document.getElementById('pomodoroDots');
  container.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const dot = document.createElement('div');
    dot.className = `dot ${i < (state.timer.sessionsCompleted % 4) ? 'filled' : ''}`;
    container.appendChild(dot);
  }
}

// ── Persistent Floating Study Widget ──
function updateFloatingTimerWidget() {
  let widget = document.getElementById('floatingTimerWidget');
  if (!widget) {
    widget = document.createElement('div');
    widget.id = 'floatingTimerWidget';
    widget.className = 'floating-timer-widget';
    
    widget.innerHTML = `
      <div class="floating-pulse"></div>
      <span class="floating-text">25:00</span>
    `;
    
    // Click navigates straight to focus page
    widget.addEventListener('click', () => {
      navigateTo('timer');
    });
    
    document.body.appendChild(widget);
  }
  
  const textEl = widget.querySelector('.floating-text');
  const pulseEl = widget.querySelector('.floating-pulse');
  
  // Format timeLeft
  const m = Math.floor(state.timer.timeLeft / 60);
  const s = Math.floor(state.timer.timeLeft % 60);
  textEl.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  
  // Pulse color classes based on mode
  if (state.timer.mode === 'pomodoro') {
    pulseEl.className = 'floating-pulse mode-focus';
  } else {
    pulseEl.className = 'floating-pulse mode-break';
  }

  // Float style only when timer is running
  if (state.timer.isRunning) {
    widget.classList.add('visible');
  } else {
    widget.classList.remove('visible');
  }
}

// ── Pomodoro Fullscreen Break Lock Screen Overlay ──
function showPomodoroBreakLockOverlay() {
  let overlay = document.getElementById('pomodoroBreakLockOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pomodoroBreakLockOverlay';
    overlay.className = 'pomodoro-lock-overlay';
    
    overlay.innerHTML = `
      <div class="lock-modal animate-pop">
        <div class="lock-icon">☕</div>
        <h2 class="lock-title">Time for a Short Break!</h2>
        <p class="lock-desc">
          Amazing job completing your 25-minute focus session. Stand up, stretch, grab a cup of water, and relax.
        </p>
        
        <!-- Large countdown timer -->
        <div id="lockTimerDisplay" class="lock-timer-text">05:00</div>
        
        <!-- Skip Break Option -->
        <button id="skipBreakBtn" class="btn-outline" style="margin-bottom: 8px; border-color: rgba(0, 245, 212, 0.4); color: var(--accent-teal); font-weight: 700; padding: 10px 24px; border-radius: 12px; font-size: 0.9em; background: rgba(0, 245, 212, 0.05); cursor: pointer; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); outline: none;">
          ⚡ Skip Break & Focus
        </button>
        
        <div class="lock-quote" style="margin-top: 12px;">
          "Self-care is how you take your power back." — Breathe & Relax.
        </div>
      </div>
    `;
    
    // Block clicking inside to prevent close
    overlay.addEventListener('click', (e) => e.stopPropagation());
    
    // Wire up skip button events
    const skipBtn = overlay.querySelector('#skipBreakBtn');
    if (skipBtn) {
      skipBtn.addEventListener('mouseenter', () => {
        skipBtn.style.background = 'rgba(0, 245, 212, 0.15)';
        skipBtn.style.borderColor = 'var(--accent-teal)';
        skipBtn.style.transform = 'translateY(-2px) scale(1.03)';
        skipBtn.style.boxShadow = '0 8px 24px rgba(0, 245, 212, 0.2)';
      });
      skipBtn.addEventListener('mouseleave', () => {
        skipBtn.style.background = 'rgba(0, 245, 212, 0.05)';
        skipBtn.style.borderColor = 'rgba(0, 245, 212, 0.4)';
        skipBtn.style.transform = 'translateY(0) scale(1)';
        skipBtn.style.boxShadow = 'none';
      });
      skipBtn.addEventListener('click', () => {
        completeTimerSession();
      });
    }
    
    document.body.appendChild(overlay);
  }
  
  // Freeze scrolled viewport interactions
  document.body.classList.add('body-locked');
  
  // Trigger animations
  setTimeout(() => {
    overlay.classList.add('active');
  }, 10);
  
  updateLockOverlayDisplay();
}

function hidePomodoroBreakLockOverlay() {
  const overlay = document.getElementById('pomodoroBreakLockOverlay');
  if (overlay) {
    overlay.classList.remove('active');
    document.body.classList.remove('body-locked');
    
    setTimeout(() => {
      overlay.remove();
    }, 500);
  }
}

function updateLockOverlayDisplay() {
  const display = document.getElementById('lockTimerDisplay');
  if (display) {
    const m = Math.floor(state.timer.timeLeft / 60);
    const s = Math.floor(state.timer.timeLeft % 60);
    display.textContent = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
}

// AI Planner Logic
function setupPlanner() {
  const form = document.getElementById('plannerForm');
  const levelBtns = document.querySelectorAll('.level-btn');
  const dayBtns = document.querySelectorAll('.day-btn');
  const hoursSlider = document.getElementById('dailyHours');
  const hoursValue = document.getElementById('hoursValue');
  
  hoursSlider.addEventListener('input', (e) => {
    hoursValue.textContent = `${e.target.value} hrs`;
  });

  levelBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      levelBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  dayBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    generateStudyPlan();
  });
}

function generateStudyPlan() {
  const btn = document.getElementById('generateBtn');
  const btnText = document.getElementById('generateBtnText');
  const topic = document.getElementById('studyTopic').value || 'General Studies';
  const startDate = document.getElementById('startDate').value;
  const goalDate = document.getElementById('goalDate').value;
  const hours = document.getElementById('dailyHours').value;
  const level = document.querySelector('.level-btn.active')?.dataset.level || 'beginner';
  const objectives = document.getElementById('objectives').value;
  
  btnText.textContent = 'AI is thinking...';
  btn.style.opacity = '0.8';
  btn.disabled = true;

  fetch('/api/generate_plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, start_date: startDate, goal_date: goalDate, hours, level, objectives })
  })
  .then(res => res.json())
  .then(data => {
    btnText.textContent = 'Generate My Study Plan';
    btn.style.opacity = '1';
    btn.disabled = false;
    
    document.getElementById('plannerOutput').style.display = 'block';
    
    const output = document.getElementById('planContent');
    if (data.error) {
      output.innerHTML = `<div class="plan-item" style="border-left-color: #ef4444;"><h4>Error</h4><p>${data.error}</p></div>`;
      showToast('Failed to generate plan', 'error');
    } else {
      output.innerHTML = data.plan;
      showToast('Plan generated and fully configured by AI Agent!', 'success');
      
      // Autonomous System: Refresh all data affected by the AI Agent
      fetch('/api/subjects').then(r => r.json()).then(d => { state.subjects = d; if(typeof renderSubjectsList === 'function') renderSubjectsList(); });
      fetch('/api/sessions').then(r => r.json()).then(d => { state.sessions = d; if(typeof renderSchedule === 'function') renderSchedule(); });
      fetch('/api/notes').then(r => r.json()).then(d => { state.notes = d; if(typeof renderNotesList === 'function') renderNotesList(); });
    }
    document.getElementById('plannerOutput').scrollIntoView({ behavior: 'smooth' });
  })
  .catch(err => {
    btnText.textContent = 'Generate My Study Plan';
    btn.style.opacity = '1';
    btn.disabled = false;
    showToast('An error occurred', 'error');
  });
}

// Notes Logic
function setupNotes() {
  const newNoteBtn = document.getElementById('newNoteBtn');
  newNoteBtn.addEventListener('click', createNewNote);

  const autoGenBtn = document.getElementById('autoGenerateNoteBtn');
  if (autoGenBtn) {
    autoGenBtn.addEventListener('click', autoGenerateNote);
  }
  
  fetch('/api/notes')
    .then(res => res.json())
    .then(data => {
      state.notes = data;
      renderNotesList();
    });
}

function createNewNote() {
  const newNote = { title: 'Untitled Note', body: '' };
  
  fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newNote)
  })
  .then(res => res.json())
  .then(data => {
    state.notes.unshift(data);
    renderNotesList();
    openNote(data.id);
  });
}

function deleteNote(id) {
  if (!confirm('Delete this note? This cannot be undone.')) return;
  fetch(`/api/notes/${id}`, { method: 'DELETE' })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        state.notes = state.notes.filter(n => n.id !== id);
        renderNotesList();
        // Clear editor
        document.getElementById('notesEditorArea').innerHTML = `
          <div class="empty-state large">
            <div class="empty-icon"></div>
            <h3>Select or create a note</h3>
            <p>Your notes will appear here</p>
          </div>`;
        showToast('Note deleted', 'info');
      }
    });
}

function renderNotesList() {
  const list = document.getElementById('notesList');
  list.innerHTML = '';

  if (state.notes.length === 0) {
    list.innerHTML = '<div class="empty-state small"><p>No notes yet</p></div>';
    updateDashboardStats();
    return;
  }

  state.notes.forEach(note => {
    const item = document.createElement('div');
    item.className = 'note-item';
    item.style.position = 'relative';
    
    // Clean up markdown hashes from list preview snippet
    const cleanSnippet = (note.body || '')
      .replace(/^[#\s\-*]+/g, '')
      .substring(0, 40) || 'No additional text...';

    item.innerHTML = `
      <h4 style="padding-right:28px;">${note.title || 'Untitled'}</h4>
      <p>${cleanSnippet}</p>
      <button class="note-delete-btn" title="Delete note" style="
        position:absolute;top:10px;right:10px;
        background:none;border:none;cursor:pointer;
        color:var(--text-muted);padding:2px;line-height:1;
        opacity:0;transition:opacity 0.2s;
      ">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M4 4h8M6 4V3a1 1 0 011-1h2a1 1 0 011 1v1M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    `;

    // Show/hide delete button on hover
    item.addEventListener('mouseenter', () => item.querySelector('.note-delete-btn').style.opacity = '1');
    item.addEventListener('mouseleave', () => item.querySelector('.note-delete-btn').style.opacity = '0');

    // Delete button click — stop propagation so it doesn't open the note
    item.querySelector('.note-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteNote(note.id);
    });

    item.addEventListener('click', () => {
      document.querySelectorAll('.note-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      openNote(note.id);
    });

    list.appendChild(item);
  });

  updateDashboardStats();
}

// ── Lightweight Note Markdown Parser ──
function renderMarkdown(text) {
  if (!text || text.trim() === '') {
    return '<p class="note-preview-p" style="color:var(--text-muted);font-style:italic;">No content yet. Click Edit to start typing!</p>';
  }
  
  // 1. Escape HTML to prevent XSS but allow our generated tags
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 2. Parse Code Blocks: ```code```
  html = html.replace(/```([\s\S]*?)```/g, (match, code) => {
    return `<pre class="note-preview-pre"><code>${code.trim()}</code></pre>`;
  });

  // 3. Parse Inline Code: `code`
  html = html.replace(/`([^`\n]+)`/g, '<code class="note-preview-code">$1</code>');

  // 4. Split into lines to parse headers, lists, etc.
  const lines = html.split('\n');
  let result = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // Parse list items (- item or * item)
    const listMatch = line.match(/^[-*]\s+(.*)/);
    if (listMatch) {
      if (!inList) {
        result.push('<ul class="note-preview-ul">');
        inList = true;
      }
      let content = listMatch[1];
      content = parseInlineMarkdown(content);
      result.push(`<li class="note-preview-li">${content}</li>`);
      continue;
    } else {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
    }

    // Parse Headers
    if (line.startsWith('### ')) {
      const heading = parseInlineMarkdown(line.substring(4));
      result.push(`<h3 class="note-preview-h3">${heading}</h3>`);
    } else if (line.startsWith('## ')) {
      const heading = parseInlineMarkdown(line.substring(3));
      result.push(`<h2 class="note-preview-h2">${heading}</h2>`);
    } else if (line.startsWith('# ')) {
      const heading = parseInlineMarkdown(line.substring(2));
      result.push(`<h1 class="note-preview-h1">${heading}</h1>`);
    } else if (line === '') {
      result.push('<div style="height:10px;"></div>');
    } else {
      // Regular paragraph line
      let content = parseInlineMarkdown(line);
      result.push(`<p class="note-preview-p">${content}</p>`);
    }
  }

  if (inList) {
    result.push('</ul>');
  }

  return result.join('\n');
}

function parseInlineMarkdown(text) {
  // Bold: **text**
  let parsed = text.replace(/\*\*([^*]+)\*\*/g, '<strong class="note-preview-bold">$1</strong>');
  // Italic: *text*
  parsed = parsed.replace(/\*([^*]+)\*/g, '<em class="note-preview-italic">$1</em>');
  return parsed;
}

function openNote(id) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;
  const editorArea = document.getElementById('notesEditorArea');
  
  // Default to edit mode if note is completely empty
  const defaultToEdit = !note.body || note.body.trim() === '';

  editorArea.innerHTML = `
    <div class="note-editor" style="display:flex; flex-direction:column; height:100%;">
      <!-- Header Toolbar -->
      <div style="display:flex; justify-content:space-between; align-items:center; padding:16px 24px; border-bottom:1px solid var(--border-color); gap:16px;">
        <input type="text" class="note-title-input" value="${note.title || ''}" placeholder="Note Title" style="flex:1; margin:0; padding:0; border:none; background:transparent; font-size:1.5rem; font-weight:700; color:var(--text-main); outline:none;">
        <div style="display:flex; align-items:center; gap:12px; flex-shrink:0;">
          <!-- Edit/Preview Glass Switcher -->
          <div class="toggle-switch-glass">
            <button id="noteTogglePreviewBtn" class="toggle-btn ${!defaultToEdit ? 'active' : ''}">👁️ Preview</button>
            <button id="noteToggleEditBtn" class="toggle-btn ${defaultToEdit ? 'active' : ''}">✏️ Edit</button>
          </div>
          <!-- Delete button -->
          <button id="deleteNoteEditorBtn" title="Delete note" style="
            background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3);
            color:#ef4444; border-radius:8px; padding:8px 14px; cursor:pointer;
            font-size:0.8em; display:flex; align-items:center; gap:5px; white-space:nowrap;
          ">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M4 4h8M6 4V3a1 1 0 011-1h2a1 1 0 011 1v1M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            Delete
          </button>
        </div>
      </div>
      
      <!-- Content Container -->
      <div class="note-content-container" style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
        <!-- Preview Panel -->
        <div id="notePreviewPanel" class="note-preview-area" style="display:${!defaultToEdit ? 'block' : 'none'}; padding:24px; overflow-y:auto; flex:1;">
          ${renderMarkdown(note.body)}
        </div>
        <!-- Edit Panel -->
        <textarea class="note-body-input" id="noteBodyInput" placeholder="Start typing your notes here..." style="display:${defaultToEdit ? 'block' : 'none'}; width:100%; height:100%; border:none; outline:none; background:transparent; padding:24px; font-size:1rem; color:var(--text-main); resize:none; font-family:inherit; line-height:1.6;">${note.body || ''}</textarea>
      </div>
    </div>
  `;

  editorArea.querySelector('#deleteNoteEditorBtn').addEventListener('click', () => deleteNote(id));
  
  const titleInput = editorArea.querySelector('.note-title-input');
  const bodyInput = editorArea.querySelector('#noteBodyInput');
  const previewPanel = editorArea.querySelector('#notePreviewPanel');
  const previewBtn = editorArea.querySelector('#noteTogglePreviewBtn');
  const editBtn = editorArea.querySelector('#noteToggleEditBtn');
  
  // Setup switch handlers
  previewBtn.addEventListener('click', () => {
    previewBtn.classList.add('active');
    editBtn.classList.remove('active');
    bodyInput.style.display = 'none';
    previewPanel.style.display = 'block';
    previewPanel.innerHTML = renderMarkdown(note.body);
  });

  editBtn.addEventListener('click', () => {
    editBtn.classList.add('active');
    previewBtn.classList.remove('active');
    previewPanel.style.display = 'none';
    bodyInput.style.display = 'block';
    bodyInput.focus();
  });

  let timeoutId;
  const saveNote = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      fetch(`/api/notes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: note.title, body: note.body })
      });
    }, 1000);
  };

  titleInput.addEventListener('input', (e) => {
    note.title = e.target.value;
    renderNotesList();
    saveNote();
  });
  
  bodyInput.addEventListener('input', (e) => {
    note.body = e.target.value;
    previewPanel.innerHTML = renderMarkdown(note.body);
    renderNotesList();
    saveNote();
  });
}

function autoGenerateNote() {
  const topic = prompt("Enter a topic to generate study notes for:");
  if (!topic) return;
  
  showToast('AI is generating notes...', 'info');
  
  fetch('/api/generate_notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: topic })
  })
  .then(res => res.json())
  .then(data => {
    if (data.error) {
      showToast(data.error, 'error');
      return;
    }
    
    const newNote = { title: `${topic} (AI Generated)`, body: data.notes };
    
    fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newNote)
    })
    .then(res => res.json())
    .then(savedNote => {
      state.notes.unshift(savedNote);
      renderNotesList();
      openNote(savedNote.id);
      showToast('Notes generated successfully!', 'success');
    });
  })
  .catch(err => {
    showToast('Failed to generate notes', 'error');
  });
}

// UI Utilities
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icon = type === 'success' ? '' : (type === 'error' ? '' : '');
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  
  container.appendChild(toast);
  setTimeout(() => {
    if(container.contains(toast)) container.removeChild(toast);
  }, 3500);
}

function setupModals() {
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if(e.target === document.getElementById('modalOverlay')) closeModal();
  });
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
}

function updateDashboardStats() {
  if (state.sessions) {
    const completedDates = [...new Set(state.sessions.filter(s => s.completed === 1).map(s => s.date))];
    let currentStreak = 0;
    let checkDate = new Date();
    checkDate.setHours(0,0,0,0);
    
    const fmt = (d) => {
      const offset = d.getTimezoneOffset() * 60000;
      return new Date(d.getTime() - offset).toISOString().split('T')[0];
    };
    
    if (completedDates.includes(fmt(checkDate))) {
      currentStreak++;
      checkDate.setDate(checkDate.getDate() - 1);
      while(completedDates.includes(fmt(checkDate))) {
        currentStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      }
    } else {
      checkDate.setDate(checkDate.getDate() - 1);
      if (completedDates.includes(fmt(checkDate))) {
        currentStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
        while(completedDates.includes(fmt(checkDate))) {
          currentStreak++;
          checkDate.setDate(checkDate.getDate() - 1);
        }
      }
    }
    state.streak = currentStreak;
  }

  const streakEl = document.getElementById('streakCount');
  if (streakEl) streakEl.textContent = state.streak;

  // ── Stat Cards ──
  const completedCount = state.subjects.filter(s => s.status === 'completed').length;
  const totalSubjects = state.subjects.length;
  const completionPct = totalSubjects === 0 ? 0 : Math.round((completedCount / totalSubjects) * 100);
  const totalMinutes = state.sessions.reduce((acc, s) => acc + (parseInt(s.duration) || 0), 0);
  const totalHours = Math.round(totalMinutes / 60);

  const el = (id) => document.getElementById(id);
  if (el('statSubjects')) el('statSubjects').textContent = totalSubjects;
  if (el('statCompleted')) el('statCompleted').textContent = `${completionPct}%`;
  if (el('statHours')) el('statHours').textContent = `${totalHours}h`;
  if (el('statStreak')) el('statStreak').textContent = `${state.streak || 0}`;
  if (el('statNotes')) el('statNotes').textContent = state.notes?.length || 0;

  // ── Subject Progress List ──
  const subjList = el('subjectProgressList');
  if (subjList) {
    if (totalSubjects === 0) {
      subjList.innerHTML = '<div class="empty-state small"><p>No subjects added yet.</p></div>';
    } else {
      const colors = ['#7c3aed','#0891b2','#059669','#f59e0b','#ec4899','#ef4444'];
      subjList.innerHTML = state.subjects.slice(0, 6).map((s, i) => {
        const pct = s.status === 'completed' ? 100 : (s.status === 'in_progress' ? Math.min(70, Math.round(Math.random() * 40 + 30)) : 0);
        const color = s.color || colors[i % colors.length];
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <div style="width:32px;height:32px;border-radius:10px;background:${color}22;display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;">${getSubjectEmoji(s.name)}</div>
            <div style="flex:1;min-width:0;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
                <span style="font-size:0.87em;font-weight:600;color:var(--text-light);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70%;">${s.name}</span>
                <span style="font-size:0.75em;color:${color};font-weight:700;flex-shrink:0;">${pct}%</span>
              </div>
              <div style="height:4px;border-radius:4px;background:rgba(255,255,255,0.06);overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:${color};border-radius:4px;transition:width 0.8s ease;"></div>
              </div>
            </div>
          </div>`;
      }).join('');
    }
  }

  // ── Upcoming Sessions (next 5 future sessions) ──
  const upcomingEl = el('upcomingSessionsList');
  if (upcomingEl) {
    const todayStr = new Date().toISOString().split('T')[0];
    const upcoming = state.sessions
      .filter(s => s.date >= todayStr && s.completed !== 1)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
      .slice(0, 5);
    if (upcoming.length === 0) {
      upcomingEl.innerHTML = '<div class="empty-state small"><p>No upcoming sessions. <button class="btn-primary btn-sm" style="margin-left:6px;" onclick="navigateTo(\'ai-planner\')">Generate Plan</button></p></div>';
    } else {
      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      upcomingEl.innerHTML = upcoming.map(s => {
        const d = new Date(s.date + 'T00:00:00');
        const day = dayNames[d.getDay()];
        const isToday = s.date === todayStr;
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="text-align:center;min-width:42px;">
                <div style="font-size:0.65em;color:var(--text-muted);text-transform:uppercase;">${isToday ? 'TODAY' : day}</div>
                <div style="font-size:1rem;font-weight:700;color:${isToday ? '#a78bfa' : 'var(--text-light)'};">${s.date.slice(8)}</div>
              </div>
              <div>
                <div style="font-size:0.88em;font-weight:600;color:var(--text-light);">${s.title}</div>
                <div style="font-size:0.75em;color:var(--text-muted);">${s.duration} min</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="background:rgba(124,58,237,0.15);color:#a78bfa;padding:3px 10px;border-radius:20px;font-size:0.75em;font-weight:600;">${s.time || '--:--'}</span>
              ${isToday ? `<button onclick="markSession(${s.id},'completed')" style="background:rgba(5,150,105,0.15);border:1px solid rgba(5,150,105,0.4);color:#059669;border-radius:6px;padding:3px 8px;font-size:0.72em;cursor:pointer;">✓ Done</button>` : ''}
            </div>
          </div>`;
      }).join('');
    }
  }

  // ── Recent Activity (improved with icons & types) ──
  const act = el('activityList');
  if (act) {
    const allItems = [
      ...state.sessions.map(s => ({ ...s, _type: 'session', _label: s.title, _time: s.date })),
      ...state.notes.map(n => ({ ...n, _type: 'note', _label: n.title, _time: n.updated_at || '' })),
      ...state.subjects.map(s => ({ ...s, _type: 'subject', _label: s.name, _time: s.created_at || '' }))
    ].sort((a, b) => (b._time || '').localeCompare(a._time || '')).slice(0, 6);

    if (allItems.length === 0) {
      act.innerHTML = '<div class="empty-state small"><p>No activity yet. Start studying!</p></div>';
    } else {
      const typeConfig = {
        session: { icon: '📅', color: '#7c3aed', label: 'Session scheduled' },
        note: { icon: '📝', color: '#0891b2', label: 'Note created' },
        subject: { icon: '📚', color: '#059669', label: 'Subject added' }
      };
      act.innerHTML = allItems.map(item => {
        const cfg = typeConfig[item._type];
        const timeStr = item._time ? item._time.slice(0, 10) : 'Recent';
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <div style="width:34px;height:34px;border-radius:10px;background:${cfg.color}18;display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0;">${cfg.icon}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:0.85em;font-weight:600;color:var(--text-light);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item._label}</div>
              <div style="font-size:0.73em;color:var(--text-muted);">${cfg.label}</div>
            </div>
            <span style="font-size:0.72em;color:var(--text-muted);background:rgba(255,255,255,0.04);padding:2px 8px;border-radius:10px;flex-shrink:0;">${timeStr}</span>
          </div>`;
      }).join('');
    }
  }
  renderBars();
}

// Analytics Logic
function renderAnalytics() {
  renderAnalyticsSummary();
  renderWeeklyBarChart();
  renderSubjectDistribution();
  renderPerformanceTrends();
  renderStudyHeatmap();
}

function renderAnalyticsSummary() {
  const container = document.getElementById('analyticsSummary');
  if (!container) return;

  const totalMinutes = state.sessions.reduce((acc, s) => acc + (parseInt(s.duration) || 0), 0);
  const avgSession = state.sessions.length > 0 ? Math.round(totalMinutes / state.sessions.length) : 0;
  const totalSubjects = state.subjects.length;
  const totalSessions = state.sessions.length;

  container.innerHTML = `
    <div class="stat-card" style="--accent:#7c3aed">
      <div class="stat-icon"></div>
      <div class="stat-body">
        <div class="stat-value">${Math.round(totalMinutes / 60)}h</div>
        <div class="stat-label">Total Time</div>
      </div>
    </div>
    <div class="stat-card" style="--accent:#0891b2">
      <div class="stat-icon"></div>
      <div class="stat-body">
        <div class="stat-value">${avgSession}m</div>
        <div class="stat-label">Avg Session</div>
      </div>
    </div>
    <div class="stat-card" style="--accent:#059669">
      <div class="stat-icon"></div>
      <div class="stat-body">
        <div class="stat-value">${totalSessions}</div>
        <div class="stat-label">Sessions</div>
      </div>
    </div>
    <div class="stat-card" style="--accent:#dc2626">
      <div class="stat-icon"></div>
      <div class="stat-body">
        <div class="stat-value">${totalSubjects}</div>
        <div class="stat-label">Subjects</div>
      </div>
    </div>
  `;
}

function getRecentStudyData() {
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const daySessions = state.sessions.filter(s => s.date === dateStr);
    const totalMin = daySessions.reduce((acc, s) => acc + (parseInt(s.duration) || 0), 0);
    days.push({ date: dateStr, minutes: totalMin, label: d.toLocaleDateString('en-US', { weekday: 'short' }) });
  }
  return days;
}

function renderWeeklyBarChart() {
  const chart = document.getElementById('weeklyBarChart');
  if(!chart) return;
  
  const data = getRecentStudyData();
  const maxMin = Math.max(...data.map(d => d.minutes), 60); // Min 60 for scale
  
  chart.innerHTML = '';
  data.forEach(d => {
    const height = (d.minutes / maxMin) * 100;
    const barWrap = document.createElement('div');
    barWrap.style = "display:flex; flex-direction:column; align-items:center; flex:1; gap:8px; height:100%; justify-content:flex-end;";
    
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = `${Math.max(5, height)}%`;
    bar.setAttribute('data-value', `${d.minutes}m`);
    
    const label = document.createElement('span');
    label.style = "font-size: 10px; color: var(--text-muted);";
    label.textContent = d.label;
    
    barWrap.appendChild(bar);
    barWrap.appendChild(label);
    chart.appendChild(barWrap);
  });
}

function renderSubjectDistribution() {
  const container = document.getElementById('donutChart');
  if (!container) return;

  const subData = {};
  state.sessions.forEach(s => {
    // Attempt to match session title with subject name or use "General"
    const sub = state.subjects.find(sub => s.title.toLowerCase().includes(sub.name.toLowerCase())) || { name: 'Other', color: '#64748b' };
    subData[sub.name] = (subData[sub.name] || 0) + (parseInt(s.duration) || 0);
  });

  const total = Object.values(subData).reduce((a, b) => a + b, 0);
  if (total === 0) {
    container.innerHTML = '<p class="text-muted">No data available</p>';
    return;
  }

  let html = '<div class="donut-chart-container"><svg viewBox="0 0 100 100" class="donut-chart-svg">';
  let offset = 0;
  const colors = ['#7c3aed', '#0891b2', '#059669', '#ec4899', '#f59e0b'];
  
  Object.entries(subData).forEach(([name, val], i) => {
    const pct = (val / total) * 100;
    const dash = `${pct} ${100 - pct}`;
    html += `<circle class="donut-segment" cx="50" cy="50" r="40" stroke="${colors[i % colors.length]}" stroke-dasharray="${dash}" stroke-dashoffset="${-offset}"></circle>`;
    offset += pct;
  });

  html += `</svg><div class="donut-center-text"><div class="donut-val">${total > 60 ? Math.round(total/60)+'h' : total+'m'}</div><div class="donut-lbl">Total</div></div></div>`;
  
  // Legend
  html += '<div style="margin-top:20px; display:grid; grid-template-columns:1fr 1fr; gap:8px;">';
  Object.entries(subData).forEach(([name, val], i) => {
    html += `<div style="display:flex; align-items:center; gap:8px; font-size:0.8rem;">
      <div style="width:10px; height:10px; border-radius:2px; background:${colors[i % colors.length]}"></div>
      <span style="color:var(--text-muted)">${name} (${Math.round((val/total)*100)}%)</span>
    </div>`;
  });
  html += '</div>';
  
  container.innerHTML = html;
}

function renderPerformanceTrends() {
  const container = document.getElementById('lineChart');
  if (!container) return;

  const data = getRecentStudyData();
  const max = Math.max(...data.map(d => d.minutes), 60);
  const width = 300;
  const height = 150;
  
  let points = "";
  data.forEach((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - (d.minutes / max) * height;
    points += `${i === 0 ? 'M' : 'L'} ${x} ${y} `;
  });

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="line-chart-svg">
      <path class="line-path" d="${points}"></path>
      ${data.map((d, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = height - (d.minutes / max) * height;
        return `<circle class="line-point" cx="${x}" cy="${y}" r="4"></circle>`;
      }).join('')}
    </svg>
  `;
}

function renderStudyHeatmap() {
  const container = document.getElementById('heatmap');
  if (!container) return;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  
  let html = '<div style="width:100%"><div class="heatmap-grid">';
  for (let i = 1; i <= daysInMonth; i++) {
    const d = new Date(year, month, i);
    const dateStr = d.toISOString().split('T')[0];
    const sessions = state.sessions.filter(s => s.date === dateStr);
    const count = sessions.length;
    let level = 0;
    if (count > 0) level = 1;
    if (count > 2) level = 2;
    if (count > 4) level = 3;
    if (count > 6) level = 4;
    
    html += `<div class="heatmap-day level-${level}" data-date="${dateStr}" title="${count} sessions"></div>`;
  }
  html += '</div>';
  
  // Legend
  html += `
    <div class="analytics-legend">
      <span>Less</span>
      <div class="legend-item"><div class="legend-color level-0"></div></div>
      <div class="legend-item"><div class="legend-color level-1"></div></div>
      <div class="legend-item"><div class="legend-color level-2"></div></div>
      <div class="legend-item"><div class="legend-color level-3"></div></div>
      <div class="legend-item"><div class="legend-color level-4"></div></div>
      <span>More</span>
    </div>
  </div>`;
  
  container.innerHTML = html;
}

function renderBars() {
  // Replaced by renderWeeklyBarChart, but keeping for dashboard compatibility if needed
  renderWeeklyBarChart();
}

// AI Features

function fetchInsight() {
  const refreshBtn = document.getElementById('refreshInsightBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadNewInsight);
  loadNewInsight();
}

function loadNewInsight() {
  const textEl = document.getElementById('insightText');
  const dotsEl = document.getElementById('insightDots');
  
  textEl.textContent = "Analyzing your study patterns...";
  if(dotsEl) dotsEl.style.display = 'inline-block';
  
  fetch('/api/ai_insights')
    .then(res => res.json())
    .then(data => {
      textEl.innerHTML = `<strong>Insight:</strong> ${data.insight}`;
      if(dotsEl) dotsEl.style.display = 'none';
    })
    .catch(err => {
      textEl.textContent = "Keep up the great work today!";
      if(dotsEl) dotsEl.style.display = 'none';
    });
}

function setupTutor() {
  const sendBtn = document.getElementById('tutorSendBtn');
  const inputEl = document.getElementById('tutorInput');
  
  if(!sendBtn || !inputEl) return;
  
  const sendMessage = () => {
    const question = inputEl.value.trim();
    if (!question) return;
    
    appendChatMessage('user', question);
    inputEl.value = '';
    
    // Add loading message
    const loadingId = 'loading-' + Date.now();
    appendChatMessage('bot', '<div class="typing-dots"><span></span><span></span><span></span></div>', loadingId);
    
    fetch('/api/ai_tutor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question, context: "General Studies" })
    })
    .then(res => res.json())
    .then(data => {
      document.getElementById(loadingId)?.remove();
      if (data.error) {
        appendChatMessage('bot', "Sorry, I ran into an error: " + data.error);
      } else {
        appendChatMessage('bot', data.answer.replace(/\n/g, '<br>'));
      }
    })
    .catch(err => {
      document.getElementById(loadingId)?.remove();
      appendChatMessage('bot', "Connection error. Please try again later.");
    });
  };
  
  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
}

function appendChatMessage(role, htmlContent, id = null) {
  const chatArea = document.getElementById('tutorChatArea');
  if (!chatArea) return;
  
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-message ${role}`;
  if (id) msgDiv.id = id;
  
  if (role === 'user') {
    msgDiv.style = "background: rgba(255, 255, 255, 0.05); padding: 15px; border-radius: 12px; align-self: flex-end; max-width: 80%; text-align: right;";
    msgDiv.innerHTML = `<strong>You:</strong> ${htmlContent}`;
  } else {
    msgDiv.style = "background: rgba(124, 58, 237, 0.1); padding: 15px; border-radius: 12px; border-left: 4px solid var(--primary); align-self: flex-start; max-width: 80%;";
    msgDiv.innerHTML = `<strong>AI Tutor:</strong> <br> ${htmlContent}`;
  }
  
  chatArea.appendChild(msgDiv);
  chatArea.scrollTop = chatArea.scrollHeight;
}

// Subjects Logic
function setupSubjects() {
  const btn1 = document.getElementById('addSubjectBtn');
  const btn2 = document.getElementById('addSubjectBtn2');
  
  const addSubject = () => {
    const name = prompt("Enter subject name:");
    if (!name) return;
    
    const color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
    
    fetch('/api/subjects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, color: color })
    })
    .then(res => res.json())
    .then(data => {
      state.subjects.unshift(data);
      renderSubjectsList();
      populateTimerSubjects();
      showToast('Subject added successfully!', 'success');
    });
  };

  if (btn1) btn1.addEventListener('click', addSubject);
  if (btn2) btn2.addEventListener('click', addSubject);
  
  const filterBtns = document.querySelectorAll('.subject-filters .filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.subjectFilter = btn.getAttribute('data-filter');
      renderSubjectsList();
    });
  });
  
  fetch('/api/subjects')
    .then(res => res.json())
    .then(data => {
      state.subjects = data;
      renderSubjectsList();
      populateTimerSubjects();
    });
}

function renderSubjectsList() {
  const grid = document.getElementById('subjectsGrid');
  if (!grid) return;
  
  if (state.subjects.length === 0) {
    grid.innerHTML = `
      <div class="empty-state large">
        <div class="empty-icon"></div>
        <h3>No subjects yet</h3>
        <p>Add your first subject to get started</p>
        <button class="btn-primary" onclick="document.getElementById('addSubjectBtn').click()">+ Add Subject</button>
      </div>
    `;
    return;
  }
  
  grid.innerHTML = '';
  
  const filteredSubjects = state.subjects.filter(s => {
    if (state.subjectFilter === 'all') return true;
    if (state.subjectFilter === 'active') return s.status === 'active';
    if (state.subjectFilter === 'completed') return s.status === 'completed';
    return true;
  });
  
  if (filteredSubjects.length === 0 && state.subjects.length > 0) {
    grid.innerHTML = `<div class="empty-state large" style="grid-column: 1 / -1;"><p>No ${state.subjectFilter} subjects found.</p></div>`;
    return;
  }
  
  filteredSubjects.forEach(subject => {
    const isCompleted = subject.status === 'completed';
    const card = document.createElement('div');
    card.className = 'card subject-card';
    card.style = `border-top: 4px solid ${subject.color || '#7c3aed'}; opacity: ${isCompleted ? '0.7' : '1'};`;
    card.innerHTML = `
      <div class="card-header" style="justify-content: space-between;">
        <h3 style="margin: 0;">${subject.name}</h3>
        <button class="btn-icon" onclick="deleteSubject(${subject.id})" title="Delete" style="color: var(--text-muted);">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M4 4h8M6 4V3a1 1 0 011-1h2a1 1 0 011 1v1M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div style="padding: 15px; display: flex; justify-content: space-between; align-items: center;">
        <p style="color: var(--text-muted); font-size: 0.9em; margin: 0;">Status: <strong>${subject.status || 'active'}</strong></p>
        <button class="btn-outline btn-sm" onclick="toggleSubjectStatus(${subject.id}, '${isCompleted ? 'active' : 'completed'}')">
          ${isCompleted ? 'Mark Active' : 'Mark Completed'}
        </button>
      </div>
    `;
    grid.appendChild(card);
  });
  
  updateDashboardStats();
}

window.deleteSubject = function(id) {
  if (!confirm("Are you sure you want to delete this subject?")) return;
  
  fetch(`/api/subjects/${id}`, { method: 'DELETE' })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        state.subjects = state.subjects.filter(s => s.id !== id);
        renderSubjectsList();
        populateTimerSubjects();
        showToast('Subject deleted', 'info');
      }
    });
};

window.toggleSubjectStatus = function(id, newStatus) {
  fetch(`/api/subjects/${id}/toggle`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: newStatus })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      const subject = state.subjects.find(s => s.id === id);
      if (subject) {
        subject.status = newStatus;
        renderSubjectsList();
        showToast(`Subject marked as ${newStatus}`, 'success');
      }
    }
  });
};

// Schedule Logic
function setupSchedule() {
  const btn = document.getElementById('addSessionBtn');
  
  const openAddSessionModal = () => {
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    const modalOverlay = document.getElementById('modalOverlay');
    
    modalTitle.textContent = "Schedule New Session";
    
    const subjectOptions = state.subjects.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
    
    modalBody.innerHTML = `
      <div class="form-group" style="margin-bottom: 15px;">
        <label>Subject / Title</label>
        <select id="sessSubject" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-card); color: white;">
          <option value="">Select a subject...</option>
          ${subjectOptions}
          <option value="General Study">General Study</option>
        </select>
      </div>
      <div class="form-row" style="display:flex; gap:10px; margin-bottom: 15px;">
        <div class="form-group" style="flex:1;">
          <label>Date</label>
          <input type="date" id="sessDate" value="${new Date().toISOString().split('T')[0]}" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-card); color: white;">
        </div>
        <div class="form-group" style="flex:1;">
          <label>Time</label>
          <input type="time" id="sessTime" value="14:00" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-card); color: white;">
        </div>
      </div>
      <div class="form-group" style="margin-bottom: 20px;">
        <label>Duration (minutes)</label>
        <input type="number" id="sessDuration" value="60" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-card); color: white;">
      </div>
      <button class="btn-primary" id="saveSessionBtn" style="width: 100%;">Add to Schedule</button>
    `;
    
    modalOverlay.classList.add('active');
    
    document.getElementById('saveSessionBtn').onclick = () => {
      const title = document.getElementById('sessSubject').value || "Study Session";
      const date = document.getElementById('sessDate').value;
      const time = document.getElementById('sessTime').value;
      const duration = document.getElementById('sessDuration').value;
      
      if (!date || !time) return showToast("Please fill all fields", "error");

      fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, date, time, duration: parseInt(duration) || 60 })
      })
      .then(res => res.json())
      .then(data => {
        state.sessions.push(data);
        renderSchedule();
        closeModal();
        showToast('Session scheduled!', 'success');
      });
    };
  };

  if (btn) btn.addEventListener('click', openAddSessionModal);
  
  fetch('/api/sessions')
    .then(res => res.json())
    .then(data => {
      state.sessions = data;
      renderSchedule();
    });
}

function renderSchedule() {
  const grid = document.getElementById('weekGrid');
  if (!grid) return;
  
  if (state.sessions.length === 0) {
    grid.innerHTML = `
      <div class="empty-state large" style="grid-column: 1 / -1;">
        <div class="empty-icon"></div>
        <h3>No sessions scheduled</h3>
        <p>Add your first study session</p>
      </div>
    `;
    return;
  }
  
  grid.innerHTML = '';
  // Group by date
  const grouped = {};
  state.sessions.forEach(s => {
    if (!grouped[s.date]) grouped[s.date] = [];
    grouped[s.date].push(s);
  });
  
  // Create a column for each date
  Object.keys(grouped).sort().forEach(date => {
    const col = document.createElement('div');
    col.className = 'day-column';
    col.innerHTML = `<h3 style="text-align:center; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 8px;">${date}</h3>`;
    
    grouped[date].forEach(session => {
      const subject = state.subjects.find(sub => session.title.includes(sub.name));
      const color = subject ? subject.color : 'var(--primary)';
      const isDone = session.completed === 1;

      const card = document.createElement('div');
      card.className = 'card';
      card.style = `margin-top:10px;border-left:4px solid ${isDone ? '#059669' : color};
        padding:15px;position:relative;background:${isDone ? 'rgba(5,150,105,0.05)' : 'rgba(255,255,255,0.02)'};`;
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:start;">
          <h4 style="margin:0 0 5px;${isDone ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${session.title}</h4>
          <span style="font-size:0.7em;background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px;">${session.duration}m</span>
        </div>
        <p style="margin:0 0 10px;color:var(--text-muted);font-size:0.9em;"> ${session.time}</p>
        ${isDone
          ? '<span style="font-size:0.78em;color:#059669;font-weight:600;"> Completed</span>'
          : `<div style="display:flex;gap:6px;">
              <button onclick="markSession(${session.id},'completed')" style="
                background:rgba(5,150,105,0.15);border:1px solid rgba(5,150,105,0.4);
                color:#059669;border-radius:6px;padding:4px 10px;font-size:0.75em;
                cursor:pointer;font-weight:600;">✓ Done</button>
              <button onclick="markSession(${session.id},'skipped')" style="
                background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);
                color:#ef4444;border-radius:6px;padding:4px 10px;font-size:0.75em;
                cursor:pointer;">✕ Skip</button>
            </div>`
        }
        <button class="btn-icon" onclick="deleteSession(${session.id})" style="position:absolute;top:10px;right:10px;color:var(--text-muted);" title="Delete">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M4 4h8M6 4V3a1 1 0 011-1h2a1 1 0 011 1v1M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      `;
      col.appendChild(card);
    });
    grid.appendChild(col);
  });
  
  // Render today's schedule on dashboard
  const todayContainer = document.getElementById('todaySchedule');
  if (todayContainer) {
    const todayStr = new Date().toISOString().split('T')[0];
    const todaySessions = grouped[todayStr] || [];
    if (todaySessions.length === 0) {
      todayContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"></div>
          <p>No sessions scheduled for today</p>
          <button class="btn-primary btn-sm" onclick="navigateTo('ai-planner')">Generate with AI</button>
        </div>
      `;
    } else {
      todayContainer.innerHTML = todaySessions.map(s => {
        const isDone = s.completed === 1;
        return `
          <div style="padding:12px;border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;">
            <div>
              <strong style="display:block;${isDone?'text-decoration:line-through;color:var(--text-muted);':''}">${s.title}</strong>
              <span style="color:var(--text-muted);font-size:0.85em;">${s.duration} min</span>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
              <div style="background:var(--primary);color:white;padding:4px 8px;border-radius:4px;font-weight:bold;font-size:0.8em;">${s.time}</div>
              ${isDone
                ? '<span style="font-size:0.75em;color:#059669;"></span>'
                : `<button onclick="markSession(${s.id},'completed')" style="background:rgba(5,150,105,0.15);border:1px solid rgba(5,150,105,0.4);color:#059669;border-radius:5px;padding:3px 8px;font-size:0.72em;cursor:pointer;">✓</button>`
              }
            </div>
          </div>`;
      }).join('');
    }
  }
  updateDashboardStats();
}

window.markSession = function(id, event) {
  fetch(`/api/sessions/${id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event })
  })
    .then(r => r.json())
    .then(() => {
      const s = state.sessions.find(s => s.id === id);
      if (s) s.completed = 1;
      renderSchedule();
      updateDashboardStats();
      showToast(event === 'completed' ? ' Session marked complete! Great work!' : ' Session skipped.', event === 'completed' ? 'success' : 'info');
      // Refresh progress panel if on Agent Hub
      if (state.activePage === 'agent-hub') loadProgressPanel();
    });
};

window.deleteSession = function(id) {
  if (!confirm("Are you sure you want to delete this session?")) return;
  
  fetch(`/api/sessions/${id}`, { method: 'DELETE' })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        state.sessions = state.sessions.filter(s => s.id !== id);
        renderSchedule();
        showToast('Session deleted', 'info');
      }
    });
};

// Search Logic
function setupSearch() {
  const searchInput = document.getElementById('globalSearch');
  const resultsDiv = document.getElementById('searchResults');
  
  if (!searchInput || !resultsDiv) return;
  
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    if (!query) {
      resultsDiv.style.display = 'none';
      return;
    }
    
    let resultsHtml = '';
    
    // Search Notes
    const matchedNotes = state.notes.filter(n => (n.title && n.title.toLowerCase().includes(query)) || (n.body && n.body.toLowerCase().includes(query)));
    matchedNotes.forEach(n => {
      resultsHtml += `<div style="padding:10px; border-bottom:1px solid var(--border-color); cursor:pointer;" onclick="navigateTo('notes'); openNote(${n.id}); document.getElementById('searchResults').style.display='none';">
        <span style="font-size:0.8em; color:var(--primary); text-transform:uppercase;">Note</span>
        <h5 style="margin:2px 0;">${n.title}</h5>
      </div>`;
    });
    
    // Search Subjects
    const matchedSubjects = state.subjects.filter(s => s.name.toLowerCase().includes(query));
    matchedSubjects.forEach(s => {
      resultsHtml += `<div style="padding:10px; border-bottom:1px solid var(--border-color); cursor:pointer;" onclick="navigateTo('subjects'); document.getElementById('searchResults').style.display='none';">
        <span style="font-size:0.8em; color:var(--primary); text-transform:uppercase;">Subject</span>
        <h5 style="margin:2px 0;">${s.name}</h5>
      </div>`;
    });
    
    // Search Sessions
    const matchedSessions = state.sessions.filter(s => s.title.toLowerCase().includes(query));
    matchedSessions.forEach(s => {
      resultsHtml += `<div style="padding:10px; border-bottom:1px solid var(--border-color); cursor:pointer;" onclick="navigateTo('schedule'); document.getElementById('searchResults').style.display='none';">
        <span style="font-size:0.8em; color:var(--primary); text-transform:uppercase;">Session</span>
        <h5 style="margin:2px 0;">${s.title} (${s.date})</h5>
      </div>`;
    });
    
    if (resultsHtml) {
      resultsDiv.innerHTML = resultsHtml;
      resultsDiv.style.display = 'block';
    } else {
      resultsDiv.innerHTML = '<div style="padding:10px; text-align:center; color:var(--text-muted);">No results found</div>';
      resultsDiv.style.display = 'block';
    }
  });
  
  // Hide on outside click
  document.addEventListener('click', (e) => {
    if (e.target !== searchInput && !resultsDiv.contains(e.target)) {
      resultsDiv.style.display = 'none';
    }
  });
}

// Notifications Logic
function setupNotifications() {
  const notifBtn = document.getElementById('notifBtn');
  const dropdown = document.getElementById('notifDropdown');
  const dot = document.getElementById('notifDot');
  const list = document.getElementById('notifList');
  const markReadBtn = document.getElementById('markReadBtn');
  
  if (!notifBtn || !dropdown) return;
  
  notifBtn.addEventListener('click', () => {
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
  });
  
  document.addEventListener('click', (e) => {
    if (e.target !== notifBtn && !notifBtn.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });
  
  markReadBtn.addEventListener('click', () => {
    fetch('/api/notifications/read', { method: 'POST' })
      .then(() => fetchNotifications());
  });
  
  const fetchNotifications = () => {
    fetch('/api/notifications')
      .then(res => res.json())
      .then(data => {
        if (data.length > 0) {
          dot.style.display = 'block';
          list.innerHTML = '';
          data.forEach(n => {
            list.innerHTML += `
              <div style="padding:10px; border-bottom:1px solid var(--border-color); background: rgba(255,255,255,0.02); border-radius: 6px; margin-bottom: 5px;">
                <p style="margin:0; font-size:0.95em;">${n.message}</p>
                <span style="font-size:0.75em; color:var(--text-muted);">${new Date(n.created_at).toLocaleTimeString()}</span>
              </div>
            `;
          });
        } else {
          dot.style.display = 'none';
          list.innerHTML = '<p style="text-align:center; color:var(--text-muted); font-size:0.9em; margin:10px 0;">No new notifications</p>';
        }
      });
  };
  
  fetchNotifications();
  setInterval(fetchNotifications, 5000); 
  setInterval(checkScheduledNotifications, 30000); // Check every 30 seconds
}

const notifiedSessions = new Set();
function checkScheduledNotifications() {
  const now = new Date();
  // Get local date string YYYY-MM-DD
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;
  
  // Get local time string HH:MM
  const hours = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${mins}`;

  state.sessions.forEach(s => {
    if (s.date === dateStr && s.time === timeStr && !notifiedSessions.has(s.id)) {
      pushNotification(`Focus time! Your "${s.title}" session is starting now.`);
      notifiedSessions.add(s.id);

      // Auto-start Focus Timer!
      showToast(`Automatically starting Focus Timer for "${s.title}"!`, 'success');
      
      // 1. Set mode to pomodoro (25 minutes)
      setTimerMode('pomodoro');
      
      // 2. Select subject in timerSubject dropdown if it matches
      const select = document.getElementById('timerSubject');
      const matchedSub = state.subjects.find(sub => s.title.toLowerCase().includes(sub.name.toLowerCase()));
      if (select) {
        if (matchedSub) {
          select.value = matchedSub.id;
        } else {
          select.value = ""; // Default
        }
      }
      
      // 3. Navigate to timer tab so user sees it running
      navigateTo('timer');
      
      // 4. Start the countdown
      if (!state.timer.isRunning) {
        toggleTimer();
      }

      // 5. Premium Study Transition: Stay on Focus Timer for 2 seconds, then transition to Content section
      setTimeout(() => {
        showToast(`Focus session active! Opening AI deep-dive study material for "${matchedSub ? matchedSub.name : 'your subject'}"...`, 'info');
        navigateTo('content');
        if (matchedSub) {
          triggerContentGeneration(matchedSub);
        }
      }, 2000);
    }
  });
}

function pushNotification(message) {
  // In-app notification via API
  fetch('/api/notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message })
  });
  
  // UI Feedback
  showToast(message, 'info');
  
  // Browser Native Notification
  if (window.Notification && Notification.permission === "granted") {
    new Notification("StudyMind AI", { 
      body: message,
      icon: "/static/logo.png" 
    });
  } else if (window.Notification && Notification.permission !== "denied") {
    Notification.requestPermission();
  }
}

// Profile Logic
function setupProfile() {
  const avatar = document.getElementById('userAvatar');
  if (!avatar) return;
  
  avatar.style.cursor = 'pointer';
  avatar.title = "View Profile";
  
  let activeProfileId = localStorage.getItem('activeProfileId') || 1;
  
  const loadProfiles = () => {
    fetch('/api/profiles')
      .then(res => res.json())
      .then(data => {
        state.allProfiles = data;
        const current = data.find(p => p.id == activeProfileId) || data[0];
        if (current) {
          state.profile = current;
          activeProfileId = current.id;
          localStorage.setItem('activeProfileId', activeProfileId);
          avatar.textContent = current.name.charAt(0).toUpperCase();
          avatar.style.background = current.avatar_color || 'var(--primary)';
        }
      });
  };
  
  window.switchProfile = (id) => {
    localStorage.setItem('activeProfileId', id);
    activeProfileId = id;
    window.location.reload();
  };
  
  window.addNewProfile = () => {
    const name = prompt("Enter new student name:");
    if (!name) return;
    const color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
    
    fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, avatar_color: color })
    })
    .then(res => res.json())
    .then(data => {
      switchProfile(data.id);
    });
  };
  
  avatar.addEventListener('click', () => {
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    const modalOverlay = document.getElementById('modalOverlay');
    
    modalTitle.textContent = "Profile Hub";
    
    let otherProfilesHtml = state.allProfiles.filter(p => p.id != activeProfileId).map(p => `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(255,255,255,0.02); border-radius: 8px; margin-bottom: 5px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <div style="width:30px; height:30px; border-radius:50%; background:${p.avatar_color || '#7c3aed'}; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:14px;">${p.name.charAt(0).toUpperCase()}</div>
          <span>${p.name}</span>
        </div>
        <button class="btn-outline btn-sm" onclick="switchProfile(${p.id})">Switch</button>
      </div>
    `).join('');
    
    if(!otherProfilesHtml) otherProfilesHtml = '<p style="color:var(--text-muted); font-size:0.9em;">No other profiles found.</p>';
    
    modalBody.innerHTML = `
      <div style="display: flex; gap: 20px; flex-wrap: wrap;">
        <!-- Left: Edit Form -->
        <div style="flex: 1; min-width: 250px; border-right: 1px solid var(--border-color); padding-right: 20px;">
          <h4 style="margin-top: 0; color: var(--primary);">Edit Current Profile</h4>
          <div class="form-group" style="margin-bottom: 15px;">
            <label>Full Name</label>
            <input type="text" id="profName" value="${state.profile.name || ''}" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); background: rgba(255,255,255,0.05); color: white;">
          </div>
          <div class="form-group" style="margin-bottom: 15px;">
            <label>Email Address</label>
            <input type="email" id="profEmail" value="${state.profile.email || ''}" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); background: rgba(255,255,255,0.05); color: white;">
          </div>
          <div class="form-group" style="margin-bottom: 15px;">
            <label>Institution / School</label>
            <input type="text" id="profInst" value="${state.profile.institution || ''}" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); background: rgba(255,255,255,0.05); color: white;">
          </div>
          <div class="form-group" style="margin-bottom: 15px;">
            <label>Short Bio</label>
            <textarea id="profBio" rows="2" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); background: rgba(255,255,255,0.05); color: white;">${state.profile.bio || ''}</textarea>
          </div>
          <div class="form-row" style="display:flex; gap:10px; margin-bottom: 20px;">
            <div class="form-group" style="flex:1;">
              <label>Level</label>
              <select id="profLevel" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); background: var(--card-bg); color: white;">
                <option value="Beginner" ${state.profile.level === 'Beginner' ? 'selected' : ''}>Beginner</option>
                <option value="Intermediate" ${state.profile.level === 'Intermediate' ? 'selected' : ''}>Intermediate</option>
                <option value="Advanced" ${state.profile.level === 'Advanced' ? 'selected' : ''}>Advanced</option>
              </select>
            </div>
            <div class="form-group" style="flex:2;">
              <label>Primary Goal</label>
              <input type="text" id="profGoal" value="${state.profile.goal || ''}" style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid var(--border-color); background: rgba(255,255,255,0.05); color: white;">
            </div>
          </div>
          <button class="btn-primary" id="saveProfileBtn" style="width: 100%; margin-bottom: 10px;">Save Details</button>
          <button class="btn-outline" id="deleteProfileBtn" style="width: 100%; border-color: #ef4444; color: #ef4444;">Delete Profile</button>
        </div>
        
        <!-- Right: Profile Switcher -->
        <div style="flex: 1; min-width: 250px;">
          <h4 style="margin-top: 0; color: var(--primary);">Current Profile</h4>
          <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 12px; margin-bottom: 20px; display: flex; align-items: center; gap: 15px;">
             <div style="width:50px; height:50px; border-radius:50%; background:${state.profile.avatar_color || '#7c3aed'}; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:20px;">${state.profile.name.charAt(0).toUpperCase()}</div>
             <div>
                <strong style="display:block; font-size:1.1em;">${state.profile.name}</strong>
                <span style="color:var(--text-muted); font-size:0.85em;">${state.profile.email || 'No email set'}</span>
             </div>
          </div>
          
          <h4 style="color: var(--primary);">Switch Profiles</h4>
          <div style="max-height: 150px; overflow-y: auto; margin-bottom: 15px;">
            ${otherProfilesHtml}
          </div>
          <button class="btn-outline" style="width: 100%; border-style: dashed;" onclick="addNewProfile()">+ Add Another Profile</button>
        </div>
      </div>
    `;
    
    modalOverlay.classList.add('active');
    
    document.getElementById('saveProfileBtn').addEventListener('click', () => {
      const newName = document.getElementById('profName').value;
      const newEmail = document.getElementById('profEmail').value;
      const newInst = document.getElementById('profInst').value;
      const newBio = document.getElementById('profBio').value;
      const newLevel = document.getElementById('profLevel').value;
      const newGoal = document.getElementById('profGoal').value;
      
      fetch(`/api/profiles/${activeProfileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, email: newEmail, institution: newInst, bio: newBio, level: newLevel, goal: newGoal })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          loadProfiles();
          closeModal();
          showToast('Profile updated!', 'success');
        }
      });
    });

    document.getElementById('deleteProfileBtn').addEventListener('click', () => {
      if (!confirm("Are you sure you want to delete this profile? All data associated with it will be lost forever.")) return;
      
      fetch(`/api/profiles/${activeProfileId}`, { method: 'DELETE' })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          const remaining = state.allProfiles.filter(p => p.id != activeProfileId);
          if (remaining.length > 0) {
            switchProfile(remaining[0].id);
          } else {
            fetch('/api/profiles', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: 'Student', avatar_color: '#7c3aed' })
            }).then(r => r.json()).then(d => {
              switchProfile(d.id);
            });
          }
        }
      });
    });
  });
  
  loadProfiles();
}

// ─────────────────────────────────────────
// AGENT HUB & ORCHESTRATOR
// ─────────────────────────────────────────

function setupAgentHub() {
  const triggerBtn = document.getElementById('triggerOrchBtn');
  const triggerBtn2 = document.getElementById('triggerOrchBtn2');

  const trigger = (btn) => {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = ' Running...';
    fetch('/api/orchestrator/run', { method: 'POST' })
      .then(r => r.json())
      .then(() => {
        showToast('Orchestrator triggered! Decision cycle running...', 'info');
        setTimeout(() => { refreshOrchestratorStatus(); btn.disabled = false; btn.textContent = btn.id === 'triggerOrchBtn' ? ' Run Now' : ' Trigger Decision Cycle'; }, 3000);
      });
  };

  if (triggerBtn) triggerBtn.addEventListener('click', () => trigger(triggerBtn));
  if (triggerBtn2) triggerBtn2.addEventListener('click', () => trigger(triggerBtn2));

  // Poll orchestrator status every 10s
  refreshOrchestratorStatus();
  setInterval(refreshOrchestratorStatus, 10000);
}

function refreshOrchestratorStatus() {
  fetch('/api/orchestrator/status')
    .then(r => r.json())
    .then(data => {
      const statusColor = data.status === 'running' ? '#f59e0b' : '#059669';
      const statusText = `● ${data.status}`;

      ['orchStatus', 'orchStatus2'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = statusText; el.style.color = statusColor; }
      });

      const dec = document.getElementById('lastDecisionText');
      if (dec && data.last_decision) dec.textContent = data.last_decision.substring(0, 120);

      // Feed on dashboard
      const feed = document.getElementById('agentActivityFeed');
      if (feed && data.logs && data.logs.length > 0) {
        feed.innerHTML = data.logs.map(log => `
          <div style="padding:10px 14px;border-bottom:1px solid var(--border-color);display:flex;flex-direction:column;gap:3px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="color:#f59e0b;font-weight:600;font-size:0.8em;"> ${log.agents_invoked}</span>
              <span style="color:var(--text-muted);font-size:0.75em;">${new Date(log.created_at).toLocaleTimeString()}</span>
            </div>
            <p style="margin:0;color:var(--text-muted);font-size:0.82em;">${log.outcome}</p>
          </div>`).join('');
      }

      // Orch log on Agent Hub page
      const logList = document.getElementById('orchLogList');
      if (logList && data.logs) {
        if (data.logs.length === 0) {
          logList.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">No decisions yet. Trigger a cycle or wait for the hourly run.</p>';
        } else {
          logList.innerHTML = data.logs.map(log => `
            <div style="padding:12px;border-bottom:1px solid var(--border-color);">
              <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
                <span style="color:#f59e0b;font-size:0.8em;font-weight:600;">${log.agents_invoked}</span>
                <span style="color:var(--text-muted);font-size:0.75em;">${new Date(log.created_at).toLocaleString()}</span>
              </div>
              <p style="margin:0 0 4px;font-size:0.9em;">${log.decision.substring(0,200)}</p>
              <p style="margin:0;color:#059669;font-size:0.8em;">✓ ${log.outcome}</p>
            </div>`).join('');
        }
      }

      // ── Scheduled jobs table ──
      const jobsEl = document.getElementById('schedulerJobsTable');
      if (jobsEl && data.scheduled_jobs && data.scheduled_jobs.length > 0) {
        jobsEl.innerHTML = `
          <table style="width:100%;border-collapse:collapse;font-size:0.82em;">
            <thead>
              <tr style="border-bottom:1px solid var(--border-color);">
                <th style="text-align:left;padding:6px 10px;color:var(--text-muted);font-weight:600;">Job</th>
                <th style="text-align:left;padding:6px 10px;color:var(--text-muted);font-weight:600;">Next Run (UTC)</th>
                <th style="text-align:left;padding:6px 10px;color:var(--text-muted);font-weight:600;">Countdown</th>
              </tr>
            </thead>
            <tbody>
              ${data.scheduled_jobs.map(job => {
                const next = job.next_run ? new Date(job.next_run) : null;
                const diff = next ? Math.max(0, Math.round((next - Date.now()) / 60000)) : null;
                const countdown = diff === null ? '—' : diff < 60 ? `${diff}m` : `${Math.round(diff/60)}h ${diff%60}m`;
                return `<tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                  <td style="padding:8px 10px;color:var(--text-light);font-weight:500;">${job.name}</td>
                  <td style="padding:8px 10px;color:var(--text-muted);">${next ? next.toUTCString() : '—'}</td>
                  <td style="padding:8px 10px;color:#10b981;font-weight:600;">${countdown}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>`;
      } else if (jobsEl) {
        jobsEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85em;padding:10px;">Scheduler not running or no jobs registered.</p>';
      }
    })
    .catch(() => {});
}

function loadProgressPanel() {
  fetch('/api/progress')
    .then(r => r.json())
    .then(data => {
      const el = document.getElementById('progressStatsRow');
      if (!el) return;

      const stat = (label, value, color = 'var(--text-light)', sub = '') => `
        <div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:12px;text-align:center;">
          <div style="font-size:1.5em;font-weight:700;color:${color};">${value}</div>
          <div style="font-size:0.78em;color:var(--text-muted);margin-top:2px;">${label}</div>
          ${sub ? `<div style="font-size:0.72em;color:${color};margin-top:2px;">${sub}</div>` : ''}
        </div>`;

      el.innerHTML =
        stat('Total Sessions', data.total_sessions) +
        stat('Completed', data.completed, '#059669') +
        stat('Missed', data.missed, data.missed >= 3 ? '#ef4444' : '#f59e0b',
          data.streak_risk ? ' Streak Risk!' : '') +
        stat('Day Streak', `${data.current_streak}`, '#ef4444') +
        stat('Due Today', data.due_today, '#0891b2') +
        stat('Completion Rate', `${data.completion_rate}%`,
          data.completion_rate >= 70 ? '#059669' : data.completion_rate >= 40 ? '#f59e0b' : '#ef4444') +
        stat('This Week', `${data.completions_this_week} done`, '#a78bfa',
          `${data.skips_this_week} skipped`) +
        stat('Minutes Studied', `${data.minutes_studied_this_week}m`, '#f59e0b', 'this week');
    })
    .catch(() => {});

  // Wire AI Analysis button
  const btn = document.getElementById('aiAnalysisBtn');
  if (btn && !btn._wired) {
    btn._wired = true;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = ' Analysing...';
      const adviceEl = document.getElementById('progressAiAdvice');
      fetch('/api/progress/ai_analysis')
        .then(r => r.json())
        .then(data => {
          if (adviceEl) {
            adviceEl.style.display = 'block';
            adviceEl.innerHTML = `<strong style="color:#10b981;"> AI Recommendation:</strong><br>${data.analysis}`;
          }
          btn.disabled = false;
          btn.textContent = ' AI Analysis';
        })
        .catch(() => { btn.disabled = false; btn.textContent = ' AI Analysis'; });
    });
  }
}

function refreshAgentHub() {
  refreshOrchestratorStatus();
  loadProgressPanel();
  loadAgentMemory();
  loadMessageBus();
  loadWorkspace();
  // Reasoning logs
  fetch('/api/agent_logs')
    .then(r => r.json())
    .then(logs => {
      const el = document.getElementById('agentReasoningList');
      if (!el) return;
      if (logs.length === 0) {
        el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">No reasoning traces yet. Generate a plan or trigger the orchestrator.</p>';
        return;
      }
      el.innerHTML = logs.map(log => `
        <div style="padding:12px;border-bottom:1px solid var(--border-color);margin-bottom:4px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="background:rgba(124,58,237,0.15);color:#a78bfa;padding:2px 8px;border-radius:4px;font-size:0.78em;font-weight:600;">${log.agent_name}</span>
            <span style="color:var(--text-muted);font-size:0.75em;">${new Date(log.created_at).toLocaleString()}</span>
          </div>
          <p style="margin:0 0 5px;font-size:0.8em;color:var(--text-muted);">Task: ${log.task}</p>
          <div style="margin:0;font-size:0.85em;line-height:1.5;max-height:150px;overflow-y:auto;background:rgba(0,0,0,0.15);padding:8px;border-radius:6px;border-left:3px solid #7c3aed;color:#d8b4fe;white-space:pre-wrap;">${log.reasoning}</div>
        </div>`).join('');
    })
    .catch(() => {});
}

function loadMessageBus() {
  fetch('/api/agent_messages')
    .then(r => r.json())
    .then(msgs => {
      const el = document.getElementById('agentMessageBusView');
      if (!el) return;
      if (!msgs.length) {
        el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">No messages yet. Generate a study plan to see agents communicate.</p>';
        return;
      }
      const statusColor = s => s === 'pending' ? '#f59e0b' : '#059669';
      el.innerHTML = msgs.map(m => `
        <div style="padding:10px 12px;border-bottom:1px solid var(--border-color);display:grid;grid-template-columns:1fr auto;gap:4px;">
          <div>
            <span style="font-size:0.78em;font-weight:700;color:#0891b2;">${m.from_agent}</span>
            <span style="font-size:0.78em;color:var(--text-muted);"> → </span>
            <span style="font-size:0.78em;font-weight:700;color:#7c3aed;">${m.to_agent}</span>
            <span style="font-size:0.72em;color:var(--text-muted);margin-left:6px;">[${m.subject}]</span>
            ${m.session_id ? `<span style="font-size:0.68em;background:rgba(255,255,255,0.05);padding:1px 5px;border-radius:3px;color:var(--text-muted);margin-left:4px;">session:${m.session_id}</span>` : ''}
          </div>
          <span style="font-size:0.72em;padding:2px 7px;border-radius:10px;color:${statusColor(m.status)};background:rgba(255,255,255,0.05);align-self:start;">${m.status}</span>
          <p style="margin:3px 0 0;font-size:0.82em;color:var(--text-light);grid-column:1/-1;">${(m.body||'').substring(0,120)}${(m.body||'').length>120?'…':''}</p>
          <span style="font-size:0.72em;color:var(--text-muted);grid-column:1/-1;">${new Date(m.created_at).toLocaleString()}</span>
        </div>`).join('');
    })
    .catch(() => {});

  const btn = document.getElementById('refreshBusBtn');
  if (btn && !btn._wired) { btn._wired = true; btn.addEventListener('click', loadMessageBus); }
}

function loadWorkspace() {
  fetch('/api/agent_workspace')
    .then(r => r.json())
    .then(entries => {
      const el = document.getElementById('agentWorkspaceView');
      if (!el) return;
      if (!entries.length) {
        el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">Workspace is empty. Generate a study plan to populate it.</p>';
        return;
      }
      // Group by session_id
      const sessions = {};
      entries.forEach(e => {
        if (!sessions[e.session_id]) sessions[e.session_id] = [];
        sessions[e.session_id].push(e);
      });
      el.innerHTML = Object.entries(sessions).map(([sid, items]) => `
        <div style="margin-bottom:14px;border-bottom:1px solid var(--border-color);padding-bottom:10px;">
          <div style="font-size:0.78em;color:#059669;font-weight:700;margin-bottom:6px;"> Session: ${sid}</div>
          ${items.map(e => `
            <div style="display:grid;grid-template-columns:160px 1fr;gap:4px 10px;padding:4px 0;font-size:0.82em;">
              <span style="color:var(--text-muted);">${e.key}</span>
              <span style="color:var(--text-light);word-break:break-word;">${(e.value||'').substring(0,100)}${(e.value||'').length>100?'…':''}</span>
              <span style="color:var(--text-muted);font-size:0.75em;">by ${e.written_by}</span>
              <span style="color:var(--text-muted);font-size:0.75em;">${new Date(e.updated_at).toLocaleString()}</span>
            </div>`).join('')}
        </div>`).join('');
    })
    .catch(() => {});

  const btn = document.getElementById('refreshWorkspaceBtn');
  if (btn && !btn._wired) { btn._wired = true; btn.addEventListener('click', loadWorkspace); }
}


function loadAgentMemory() {
  fetch('/api/agent_memory')
    .then(r => r.json())
    .then(grouped => {
      const el = document.getElementById('agentMemoryView');
      if (!el) return;
      const agents = Object.keys(grouped);
      if (agents.length === 0) {
        el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">No memory stored yet. Agents build memory as they act.</p>';
        return;
      }
      el.innerHTML = agents.map(agent => `
        <div style="margin-bottom:16px;border-bottom:1px solid var(--border-color);padding-bottom:12px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <span style="background:rgba(124,58,237,0.2);color:#a78bfa;padding:3px 10px;border-radius:20px;font-size:0.8em;font-weight:700;">${agent}</span>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:0.82em;">
            ${grouped[agent].map(entry => `
              <tr>
                <td style="padding:4px 8px;color:var(--text-muted);width:35%;vertical-align:top;">${entry.key}</td>
                <td style="padding:4px 8px;color:var(--text-light);word-break:break-word;">${entry.value || '—'}</td>
                <td style="padding:4px 8px;color:var(--text-muted);font-size:0.75em;white-space:nowrap;">${new Date(entry.updated_at).toLocaleString()}</td>
              </tr>`).join('')}
          </table>
        </div>`).join('');
    })
    .catch(() => {});

  // Wire refresh button
  const refreshBtn = document.getElementById('refreshMemoryBtn');
  if (refreshBtn && !refreshBtn._wired) {
    refreshBtn._wired = true;
    refreshBtn.addEventListener('click', loadAgentMemory);
  }
}


// ─────────────────────────────────────────
// EXPANDABLE CONTENT HEADINGS
// ─────────────────────────────────────────

/**
 * Makes every h1–h4 inside content tab panels expandable.
 * On first click → fetches multi-source data from /api/topic/expand
 * and animates an accordion panel open beneath the heading.
 * On second click (or "Show Less") → collapses it back.
 */
function setupExpandableHeadings() {
  // Observe any container that receives dynamic HTML (content panels + AI tutor)
  const contentRoot = document.getElementById('contentTabPanels');
  if (!contentRoot) return;

  // We'll also scan immediately for any already-rendered headings
  _bindExpandableHeadings(contentRoot);

  // Watch for future DOM changes (content rendered after phase load / generic generation)
  const observer = new MutationObserver(() => _bindExpandableHeadings(contentRoot));
  observer.observe(contentRoot, { childList: true, subtree: true });
}

function _bindExpandableHeadings(root) {
  root.querySelectorAll('h1,h2,h3,h4').forEach(heading => {
    if (heading._expandBound) return; // already wired
    heading._expandBound = true;

    const topicText = heading.textContent.trim();
    if (!topicText || topicText.length < 3) return;

    // Visual affordance — make it look interactive
    heading.style.cursor = 'pointer';
    heading.style.transition = 'opacity 0.2s';

    // Append a subtle "Read More" pill badge
    const pill = document.createElement('span');
    pill.className = 'topic-expand-pill';
    pill.textContent = '+ Read More';
    heading.appendChild(pill);

    let expanded = false;
    let panel = null;

    heading.addEventListener('mouseenter', () => { heading.style.opacity = '0.85'; });
    heading.addEventListener('mouseleave', () => { heading.style.opacity = '1'; });

    heading.addEventListener('click', async () => {
      if (expanded) {
        // Collapse
        if (panel) {
          panel.style.maxHeight = '0';
          panel.style.opacity = '0';
          setTimeout(() => { panel && panel.remove(); panel = null; }, 380);
        }
        pill.textContent = '+ Read More';
        pill.classList.remove('active');
        expanded = false;
        return;
      }

      // Expand — build skeleton loader immediately
      expanded = true;
      pill.textContent = '− Show Less';
      pill.classList.add('active');

      panel = document.createElement('div');
      panel.className = 'topic-expand-panel';
      panel.innerHTML = `
        <div class="topic-expand-loading">
          <div class="topic-expand-spinner"></div>
          <span>Fetching resources for "<strong>${topicText}</strong>"…</span>
        </div>`;
      heading.insertAdjacentElement('afterend', panel);

      // Animate open
      requestAnimationFrame(() => {
        panel.style.maxHeight = '80px';
        panel.style.opacity = '1';
      });

      try {
        const res = await fetch('/api/topic/expand', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: topicText })
        });
        const data = await res.json();

        if (!data.sources || data.sources.length === 0) {
          panel.innerHTML = `<p style="color:var(--text-muted);padding:16px 20px;">No additional resources found for this topic.</p>`;
          panel.style.maxHeight = '80px';
          return;
        }

        // Render rich source cards
        const cardsHtml = data.sources.map((src, i) => {
          const contentParagraphs = src.content
            .split('\n\n')
            .filter(p => p.trim())
            .map(p => `<p class="topic-expand-p">${p.trim()}</p>`)
            .join('');

          return `
            <div class="topic-expand-card" style="--card-accent: ${src.color}; animation-delay: ${i * 60}ms;">
              <div class="topic-expand-card-header">
                <span class="topic-expand-icon">${src.icon}</span>
                <div class="topic-expand-card-meta">
                  <span class="topic-expand-source-badge" style="background:${src.color}22;color:${src.color};border-color:${src.color}44;">${src.source}</span>
                  <h5 class="topic-expand-card-title">${src.title}</h5>
                </div>
              </div>
              <div class="topic-expand-card-body">${contentParagraphs || `<p class="topic-expand-p">${src.content}</p>`}</div>
              ${src.url ? `<a href="${src.url}" target="_blank" rel="noopener noreferrer" class="topic-expand-link">Read full article →</a>` : ''}
            </div>
          `;
        }).join('');

        panel.innerHTML = `
          <div class="topic-expand-header-bar">
            <span class="topic-expand-topic-label">📂 Deep Dive: ${data.topic}</span>
            <span class="topic-expand-count">${data.sources.length} sources</span>
          </div>
          <div class="topic-expand-cards">${cardsHtml}</div>
          <button class="topic-expand-show-less-btn" onclick="this.closest('.topic-expand-panel').previousElementSibling.click()">
            ↑ Show Less
          </button>
        `;

        // Animate to full height
        const naturalHeight = panel.scrollHeight;
        panel.style.maxHeight = naturalHeight + 'px';

      } catch (err) {
        panel.innerHTML = `<p style="color:#ef4444;padding:16px 20px;">Failed to load resources. Please check your connection.</p>`;
        panel.style.maxHeight = '80px';
      }
    });
  });
}

// Expose globally so renderContentOutput / renderPhaseContentOutput can call it
window.setupExpandableHeadings = setupExpandableHeadings;


// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
function init() {
  setupNavigation();
  updateDashboardStats();
  setupTimer();
  setupPlanner();
  setupNotes();
  setupModals();
  renderBars();
  setupTutor();
  fetchInsight();
  setupSubjects();
  setupSchedule();
  setupSearch();
  setupNotifications();
  setupProfile();
  setupAgentHub();
  setupContentHub();
  setupExpandableHeadings();
}

console.log("Setting up StudyMind AI...");
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
console.log("Setup complete. Nav items found:", navItems.length);

// ─────────────────────────────────────────
// CONTENT HUB
// ─────────────────────────────────────────

const contentState = {
  activeSubject: null,
  activeLevel: 'detailed',
  lastGenerated: null,
  generating: false
};

function setupContentHub() {
  // Level selector in content sidebar
  document.querySelectorAll('#contentLevelSelector .level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#contentLevelSelector .level-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      contentState.activeLevel = btn.dataset.level;
    });
  });

  // "Generate for first subject" button
  const firstBtn = document.getElementById('contentGenerateFromPlanBtn');
  if (firstBtn) {
    firstBtn.addEventListener('click', () => {
      if (state.subjects.length > 0) {
        triggerContentGeneration(state.subjects[0]);
      } else {
        showToast('No subjects found. Generate a study plan first!', 'error');
      }
    });
  }
}

function renderContentSubjectList() {
  const list = document.getElementById('contentSubjectList');
  if (!list) return;

  if (state.subjects.length === 0) {
    // Re-fetch in case subjects loaded after page init
    fetch('/api/subjects')
      .then(r => r.json())
      .then(data => {
        state.subjects = data;
        renderContentSubjectList();
      });
    return;
  }

  list.innerHTML = '';
  state.subjects.forEach(sub => {
    const btn = document.createElement('button');
    btn.className = 'content-subject-btn';
    btn.style.cssText = `
      display:flex;align-items:center;gap:10px;width:100%;
      padding:10px 12px;border-radius:10px;border:none;
      background:${contentState.activeSubject?.id === sub.id ? 'rgba(124,58,237,0.2)' : 'rgba(255,255,255,0.03)'};
      cursor:pointer;text-align:left;transition:all 0.2s;
      border:1px solid ${contentState.activeSubject?.id === sub.id ? 'rgba(124,58,237,0.5)' : 'transparent'};
      margin-bottom:4px;
    `;
    btn.innerHTML = `
      <div style="width:10px;height:10px;border-radius:50%;background:${sub.color || '#7c3aed'};flex-shrink:0;"></div>
      <span style="color:var(--text-light);font-size:0.9em;font-weight:500;">${sub.name}</span>
      ${contentState.activeSubject?.id === sub.id ? '<span style="margin-left:auto;font-size:0.7em;background:rgba(124,58,237,0.3);color:#a78bfa;padding:2px 6px;border-radius:10px;">Active</span>' : ''}
    `;
    btn.addEventListener('click', () => triggerContentGeneration(sub));
    btn.addEventListener('mouseenter', () => { if (contentState.activeSubject?.id !== sub.id) btn.style.background = 'rgba(255,255,255,0.06)'; });
    btn.addEventListener('mouseleave', () => { if (contentState.activeSubject?.id !== sub.id) btn.style.background = 'rgba(255,255,255,0.03)'; });
    list.appendChild(btn);
  });
}

function triggerContentGeneration(subject) {
  if (contentState.generating) { showToast('Content generation in progress...', 'info'); return; }
  contentState.activeSubject = subject;
  contentState.generating = false;
  renderContentSubjectList();

  // Check if this subject has phase-synced content
  fetch(`/api/study_phases/${encodeURIComponent(subject.name)}`)
    .then(r => r.json())
    .then(phases => {
      if (Array.isArray(phases) && phases.length > 0) {
        showPhaseContent(subject, phases);
      } else {
        triggerGenericContentGeneration(subject);
      }
    })
    .catch(() => triggerGenericContentGeneration(subject));
}

// ── Phase-Synced Content Display ──

function showPhaseContent(subject, phases) {
  document.getElementById('contentEmptyState').style.display = 'none';
  document.getElementById('contentLoadingState').style.display = 'none';
  document.getElementById('contentOutput').style.display = 'none';

  const unlocked = phases.filter(p => p.is_unlocked);
  if (!unlocked.length) {
    document.getElementById('contentEmptyState').style.display = 'block';
    return;
  }
  const activePhase = unlocked[unlocked.length - 1];

  // Inject phase timeline into content main area
  const phaseContainer = document.getElementById('phaseTimelineContainer') || createPhaseTimelineContainer();
  renderPhaseTimeline(phases, subject, phaseContainer);

  // Load the active phase's content
  loadPhaseContent(subject, activePhase);
}

function createPhaseTimelineContainer() {
  const el = document.createElement('div');
  el.id = 'phaseTimelineContainer';
  el.style.cssText = 'margin-bottom:20px;';
  const main = document.querySelector('.content-main');
  if (main) main.insertBefore(el, main.firstChild);
  return el;
}

function renderPhaseTimeline(phases, subject, container) {
  const colors = ['#7c3aed', '#0891b2', '#059669', '#f59e0b', '#ec4899'];
  const today = new Date().toISOString().split('T')[0];

  let html = `<div class="card" style="padding:20px;border:1px solid rgba(124,58,237,0.3);margin-bottom:16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <h3 style="margin:0;font-size:1em;"> Study Phases — ${subject.name}</h3>
      <button id="unlockNextPhaseBtn" class="btn-outline btn-sm" onclick="unlockNextPhase('${subject.name.replace(/'/g,"\\'")}')"> Unlock Next Phase</button>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">`;

  phases.forEach((phase, i) => {
    const color = colors[i % colors.length];
    const isActive = phase.is_unlocked && (i === phases.filter(p => p.is_unlocked).length - 1);
    const isDone = phase.is_unlocked && phase.end_date && phase.end_date < today;
    const icon = !phase.is_unlocked ? '' : isDone ? '' : isActive ? '' : '';
    const opacity = phase.is_unlocked ? '1' : '0.45';
    html += `<div onclick="${phase.is_unlocked ? `selectPhase('${subject.name.replace(/'/g,"\\'")}',${phase.phase_number})` : ''}"
      style="flex:1;min-width:140px;padding:12px 14px;border-radius:12px;
             background:${isActive ? `${color}22` : 'rgba(255,255,255,0.03)'};
             border:2px solid ${isActive ? color : 'rgba(255,255,255,0.1)'};
             cursor:${phase.is_unlocked ? 'pointer' : 'not-allowed'};
             opacity:${opacity};transition:all 0.2s;">
      <div style="font-size:1.3em;margin-bottom:4px;">${icon}</div>
      <div style="font-size:0.78em;font-weight:700;color:${color};">Phase ${phase.phase_number}</div>
      <div style="font-size:0.82em;color:var(--text-light);font-weight:500;margin-top:2px;">${phase.phase_name.replace(/^Phase \d+[:\s]+/,'')}</div>
      <div style="font-size:0.7em;color:var(--text-muted);margin-top:4px;">
        ${phase.start_date || ''} → ${phase.end_date || ''}
      </div>
      ${phase.content_generated ? '<div style="font-size:0.68em;color:#10b981;margin-top:4px;">✓ Content Ready</div>' : phase.is_unlocked ? '<div style="font-size:0.68em;color:#f59e0b;margin-top:4px;"> Generating...</div>' : ''}
    </div>`;
  });

  html += '</div></div>';
  container.innerHTML = html;
  container.style.display = 'block';
}

function loadPhaseContent(subject, phase) {
  document.getElementById('contentOutput').style.display = 'none';
  document.getElementById('contentLoadingState').style.display = 'block';
  document.getElementById('contentLoadingMsg').textContent = `Loading Phase ${phase.phase_number} content...`;

  const level = contentState.activeLevel || 'detailed';
  fetch(`/api/study_phases/${encodeURIComponent(subject.name)}/${phase.phase_number}/content?level=${level}`)
    .then(r => r.json())
    .then(data => {
      document.getElementById('contentLoadingState').style.display = 'none';
      if (data.error && data.locked) {
        showToast('This phase is still locked.', 'info'); return;
      }
      if (data.error) {
        showToast('Error: ' + data.error, 'error'); return;
      }
      renderPhaseContentOutput(data, subject, phase);
      document.getElementById('contentOutput').style.display = 'block';
      showToast(`Phase ${phase.phase_number} content loaded!`, 'success');
    })
    .catch(() => {
      document.getElementById('contentLoadingState').style.display = 'none';
      showToast('Failed to load phase content.', 'error');
    });
}

window.selectPhase = function(subjectName, phaseNumber) {
  const sub = state.subjects.find(s => s.name === subjectName) || { name: subjectName, color: '#7c3aed' };
  fetch(`/api/study_phases/${encodeURIComponent(subjectName)}`)
    .then(r => r.json())
    .then(phases => {
      const phase = phases.find(p => p.phase_number === phaseNumber);
      if (phase) loadPhaseContent(sub, phase);
    });
};

window.unlockNextPhase = function(subjectName) {
  fetch(`/api/study_phases/${encodeURIComponent(subjectName)}/unlock_next`, { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      if (data.error) { showToast(data.error, 'error'); return; }
      showToast(`Phase ${data.unlocked_phase} unlocked! Generating content...`, 'success');
      const sub = state.subjects.find(s => s.name === subjectName) || { name: subjectName, color: '#7c3aed' };
      triggerContentGeneration(sub);
    });
};

function renderPhaseContentOutput(data, subject, phase) {
  // Reuse the header card
  document.getElementById('contentSubjectTitle').textContent = `${subject.name} — Phase ${phase.phase_number}`;
  document.getElementById('contentSubjectBadge').textContent = data.phase_name || `Phase ${phase.phase_number}`;
  document.getElementById('contentSubjectIntro').textContent =
    `Phase ${phase.phase_number} | ${data.start_date || ''} → ${data.end_date || ''}`;
  document.getElementById('contentSubjectIcon').style.background = `${subject.color || '#7c3aed'}22`;
  document.getElementById('contentSubjectIcon').textContent = getSubjectEmoji(subject.name);

  // Populate panels — phases tab gets the deep phase content
  const panels = {
    'panel-phases':    data.phase_html    || '<div class="empty-state small"><p>Phase content generating... check back shortly.</p></div>',
    'panel-concepts':  data.concepts_html || '<div class="empty-state small"><p>Concepts generating...</p></div>',
    'panel-wikipedia': data.wiki_articles?.length
      ? data.wiki_articles.map(a => {
          const src = a.source || 'Wikipedia';
          const sourceBadge = `<span class='source-badge source-${src.toLowerCase().replace(' ', '-')}' style='padding:2px 8px;border-radius:4px;font-size:0.75em;font-weight:600;margin-left:8px;'>${src}</span>`;
          return `<div class="wiki-article-block" style="margin-bottom:16px;border-left:4px solid var(--primary);">
            <div class="wiki-article-title" style="display:flex;align-items:center;justify-content:space-between;">
              <span>${a.title}</span> ${sourceBadge}
            </div>
            <div class="wiki-article-body" style="margin-top:8px;">${a.snippet}</div>
            <a href="${a.url}" target="_blank" class="wiki-read-more" style="display:inline-block;margin-top:8px;">Read source material →</a>
          </div>`;
        }).join('')
      : '<div class="empty-state small"><p>No Wikipedia data.</p></div>',
    'panel-examples':  '<div class="empty-state small"><p>See phase content for examples.</p></div>',
    'panel-resources': '<div class="empty-state small"><p>See Resources tab for free materials.</p></div>',
  };
  Object.entries(panels).forEach(([id, html]) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });

  // Handle Quiz panel with custom controls
  const quizEl = document.getElementById('panel-quiz');
  if (quizEl) {
    quizEl.innerHTML = `
      <div class="card" style="padding:16px;margin-bottom:20px;border:1px dashed rgba(124,58,237,0.3);background:rgba(124,58,237,0.03);">
        <h4 style="margin:0 0 10px 0;font-size:0.95em;color:#a78bfa;display:flex;align-items:center;gap:6px;">
          ⚡ Interactive Quiz Generator
        </h4>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-size:0.75em;color:var(--text-muted);">Questions count</label>
            <select id="quizNumQuestions" style="padding:6px 12px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:var(--text-light);font-size:0.85em;min-width:100px;outline:none;">
              <option value="5">5 Questions</option>
              <option value="10" selected>10 Questions</option>
              <option value="15">15 Questions</option>
              <option value="20">20 Questions</option>
            </select>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-size:0.75em;color:var(--text-muted);">Question Style</label>
            <select id="quizQuestionStyle" style="padding:6px 12px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:var(--text-light);font-size:0.85em;min-width:140px;outline:none;">
              <option value="mixed" selected>Mixed Types</option>
              <option value="mcq">MCQ Only</option>
              <option value="scenario">Scenario/Applied</option>
              <option value="short_answer">Short Answer</option>
            </select>
          </div>
          <button id="generateCustomQuizBtn" class="btn-primary" style="margin-top:16px;padding:7px 16px;font-size:0.85em;height:fit-content;display:flex;align-items:center;gap:6px;">
            Generate Custom Quiz
          </button>
        </div>
      </div>
      <div id="quizContentArea">
        ${data.quiz_html || '<div class="empty-state small"><p>Quiz generating...</p></div>'}
      </div>
    `;
    const genBtn = document.getElementById('generateCustomQuizBtn');
    if (genBtn) {
      genBtn.addEventListener('click', () => triggerCustomQuizGeneration(subject));
    }
  }

  setupContentQuiz();

  // Wire tabs
  const tabBtns = document.querySelectorAll('#contentTabsBar .content-tab');
  const tabPanels = document.querySelectorAll('#contentTabPanels .content-tab-panel');
  tabBtns.forEach(btn => {
    btn.onclick = null;
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById(`panel-${btn.dataset.tab}`);
      if (panel) panel.classList.add('active');
    });
  });
  tabBtns.forEach(b => b.classList.remove('active'));
  tabPanels.forEach(p => p.classList.remove('active'));
  tabBtns[0]?.classList.add('active');
  tabPanels[0]?.classList.add('active');

  // Save note / refresh buttons
  const saveBtn = document.getElementById('contentSaveNoteBtn');
  if (saveBtn) saveBtn.onclick = () => saveContentAsNote(data, subject);
  const refreshBtn = document.getElementById('contentRefreshBtn');
  if (refreshBtn) refreshBtn.onclick = () => {
    fetch(`/api/study_phases/${encodeURIComponent(subject.name)}/${phase.phase_number}/regenerate`, { method: 'POST' })
      .then(() => { showToast('Regenerating phase content...', 'info'); setTimeout(() => loadPhaseContent(subject, phase), 3000); });
  };

  // Bind expandable headings for any h1-h4 injected into the panels
  setupExpandableHeadings();
}

// ── Generic (non-phase) content generation — unchanged fallback ──
function triggerGenericContentGeneration(subject) {


  // Hide empty state, show loading
  document.getElementById('contentEmptyState').style.display = 'none';
  document.getElementById('contentOutput').style.display = 'none';
  document.getElementById('contentLoadingState').style.display = 'block';

  const useWiki = document.getElementById('srcWikipedia')?.checked ?? true;
  const useArxiv = document.getElementById('srcArxiv')?.checked ?? true;
  const useWikibooks = document.getElementById('srcWikibooks')?.checked ?? true;
  const useWikiversity = document.getElementById('srcWikiversity')?.checked ?? true;
  const useOpenLibrary = document.getElementById('srcOpenLibrary')?.checked ?? true;
  const useEx = document.getElementById('srcExamples')?.checked ?? true;
  const useQuiz = document.getElementById('srcQuiz')?.checked ?? true;

  // Animated loading steps
  const steps = [];
  if (useWiki) steps.push(' Fetching Wikipedia articles...');
  if (useArxiv) steps.push(' Querying arXiv database for research papers...');
  if (useWikibooks) steps.push(' Searching Wikibooks library...');
  if (useWikiversity) steps.push(' Retrieving Wikiversity study guides...');
  if (useOpenLibrary) steps.push(' Searching Open Library for public domain books...');
  steps.push(
    ' Analyzing related knowledge...',
    ' AI generating study phases...',
    ' Extracting key concepts...',
    ' Building real-world examples...',
    ' Creating quiz questions...',
    ' Compiling resources...',
    ' Polishing content...'
  );

  let stepIdx = 0;
  const msgEl = document.getElementById('contentLoadingMsg');
  const stepsEl = document.getElementById('contentSteps');
  stepsEl.innerHTML = '';

  const stepInterval = setInterval(() => {
    if (stepIdx < steps.length) {
      if (msgEl) msgEl.textContent = steps[stepIdx];
      const dot = document.createElement('div');
      dot.className = 'content-step-item';
      dot.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;font-size:0.85em;color:var(--text-muted);animation:fadeInUp 0.3s ease;';
      dot.innerHTML = `<span style="color:#10b981;">✓</span> ${steps[stepIdx]}`;
      stepsEl.appendChild(dot);
      stepIdx++;
    } else {
      clearInterval(stepInterval);
    }
  }, 1500);

  fetch('/api/content/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: subject.name,
      level: contentState.activeLevel,
      use_wikipedia: useWiki,
      use_arxiv: useArxiv,
      use_wikibooks: useWikibooks,
      use_wikiversity: useWikiversity,
      use_openlibrary: useOpenLibrary,
      use_examples: useEx,
      use_quiz: useQuiz
    })
  })
  .then(r => r.json())
  .then(data => {
    clearInterval(stepInterval);
    contentState.generating = false;
    contentState.lastGenerated = data;

    document.getElementById('contentLoadingState').style.display = 'none';

    if (data.error) {
      showToast('Error: ' + data.error, 'error');
      document.getElementById('contentEmptyState').style.display = 'block';
      return;
    }

    renderContentOutput(data, subject);
    document.getElementById('contentOutput').style.display = 'block';
    showToast(` Content generated for "${subject.name}"!`, 'success');
  })
  .catch(err => {
    clearInterval(stepInterval);
    contentState.generating = false;
    document.getElementById('contentLoadingState').style.display = 'none';
    document.getElementById('contentEmptyState').style.display = 'block';
    showToast('Content generation failed. Check your API key.', 'error');
  });
}

function renderContentOutput(data, subject) {
  // Header
  document.getElementById('contentSubjectTitle').textContent = subject.name;
  document.getElementById('contentSubjectBadge').textContent = `${data.level} level`;
  document.getElementById('contentSubjectIntro').textContent = data.intro || '';
  document.getElementById('contentSubjectIcon').style.background = `${subject.color || '#7c3aed'}22`;
  document.getElementById('contentSubjectIcon').textContent = getSubjectEmoji(subject.name);

  // Source badges
  const badges = document.getElementById('contentSourceBadges');
  badges.innerHTML = '';
  
  // Count articles by source
  const counts = {};
  if (Array.isArray(data.wikipedia_articles)) {
    data.wikipedia_articles.forEach(a => {
      const src = a.source || 'Wikipedia';
      counts[src] = (counts[src] || 0) + 1;
    });
  }
  
  const sources = [
    { label: ' Groq AI', color: '#7c3aed', count: '6 agents' },
    { label: ' 3 Phases', color: '#059669', count: '' },
    { label: ` ${data.level}`, color: '#f59e0b', count: '' },
  ];
  
  // Add dynamic source counts first
  Object.entries(counts).forEach(([src, count]) => {
    let color = '#0891b2'; // Wikipedia/default
    if (src === 'arXiv') color = '#ec4899';
    if (src === 'Wikibooks') color = '#10b981';
    if (src === 'Wikiversity') color = '#06b6d4';
    if (src === 'Open Library') color = '#f59e0b';
    
    const badge = document.createElement('span');
    badge.className = `source-badge-tag source-${src.toLowerCase().replace(' ', '-')}`;
    badge.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:4px 12px;border-radius:20px;font-size:0.78em;background:${color}22;color:${color};border:1px solid ${color}44;font-weight:600;`;
    badge.textContent = `${src} (${count})`;
    badges.appendChild(badge);
  });
  
  sources.forEach(s => {
    const badge = document.createElement('span');
    badge.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:4px 12px;border-radius:20px;font-size:0.78em;background:${s.color}22;color:${s.color};border:1px solid ${s.color}44;font-weight:600;`;
    badge.textContent = s.label + (s.count ? ` (${s.count})` : '');
    badges.appendChild(badge);
  });

  // Wikipedia section tags
  if (data.wikipedia_sections?.length) {
    const tagWrap = document.createElement('div');
    tagWrap.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;';
    data.wikipedia_sections.slice(0, 8).forEach(sec => {
      const tag = document.createElement('span');
      tag.style.cssText = 'padding:2px 10px;background:rgba(8,145,178,0.12);color:#38bdf8;border-radius:12px;font-size:0.74em;';
      tag.textContent = sec;
      tagWrap.appendChild(tag);
    });
    badges.appendChild(tagWrap);
  }

  // Populate other panels
  const panels = {
    'panel-phases': data.phases_html,
    'panel-concepts': data.concepts_html,
    'panel-wikipedia': data.wiki_full_html,
    'panel-examples': data.examples_html,
    'panel-resources': data.resources_html
  };
  Object.entries(panels).forEach(([id, html]) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html || '<div class="empty-state small"><p>No content generated for this section.</p></div>';
  });

  // Handle Quiz panel with custom controls
  const quizEl = document.getElementById('panel-quiz');
  if (quizEl) {
    quizEl.innerHTML = `
      <div class="card" style="padding:16px;margin-bottom:20px;border:1px dashed rgba(124,58,237,0.3);background:rgba(124,58,237,0.03);">
        <h4 style="margin:0 0 10px 0;font-size:0.95em;color:#a78bfa;display:flex;align-items:center;gap:6px;">
          ⚡ Interactive Quiz Generator
        </h4>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-size:0.75em;color:var(--text-muted);">Questions count</label>
            <select id="quizNumQuestions" style="padding:6px 12px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:var(--text-light);font-size:0.85em;min-width:100px;outline:none;">
              <option value="5">5 Questions</option>
              <option value="10" selected>10 Questions</option>
              <option value="15">15 Questions</option>
              <option value="20">20 Questions</option>
            </select>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <label style="font-size:0.75em;color:var(--text-muted);">Question Style</label>
            <select id="quizQuestionStyle" style="padding:6px 12px;border-radius:8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:var(--text-light);font-size:0.85em;min-width:140px;outline:none;">
              <option value="mixed" selected>Mixed Types</option>
              <option value="mcq">MCQ Only</option>
              <option value="scenario">Scenario/Applied</option>
              <option value="short_answer">Short Answer</option>
            </select>
          </div>
          <button id="generateCustomQuizBtn" class="btn-primary" style="margin-top:16px;padding:7px 16px;font-size:0.85em;height:fit-content;display:flex;align-items:center;gap:6px;">
            Generate Custom Quiz
          </button>
        </div>
      </div>
      <div id="quizContentArea">
        ${data.quiz_html || '<div class="empty-state small"><p>No quiz generated yet.</p></div>'}
      </div>
    `;
    const genBtn = document.getElementById('generateCustomQuizBtn');
    if (genBtn) {
      genBtn.addEventListener('click', () => triggerCustomQuizGeneration(subject));
    }
  }

  // Wire up interactive quiz
  setupContentQuiz();

  // Tab switcher
  const tabBtns = document.querySelectorAll('#contentTabsBar .content-tab');
  const tabPanels = document.querySelectorAll('#contentTabPanels .content-tab-panel');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById(`panel-${btn.dataset.tab}`);
      if (panel) panel.classList.add('active');
    });
  });

  // Reset to first tab
  tabBtns.forEach(b => b.classList.remove('active'));
  tabPanels.forEach(p => p.classList.remove('active'));
  tabBtns[0]?.classList.add('active');
  tabPanels[0]?.classList.add('active');

  // Save as Note button
  const saveBtn = document.getElementById('contentSaveNoteBtn');
  if (saveBtn) {
    saveBtn.onclick = () => saveContentAsNote(data, subject);
  }

  // Refresh button
  const refreshBtn = document.getElementById('contentRefreshBtn');
  if (refreshBtn) {
    refreshBtn.onclick = () => triggerContentGeneration(subject);
  }

  // Bind expandable headings for any h1-h4 injected into the panels
  setupExpandableHeadings();
}

function setupContentQuiz() {
  // Multiple choice interactions
  // Wire up quiz buttons in both the static quiz panel and the dynamic content area
  const quizContainers = [
    document.getElementById('panel-quiz'),
    document.getElementById('quizContentArea')
  ].filter(Boolean);

  quizContainers.forEach(container => {
    container.querySelectorAll('.quiz-mcq').forEach(mcqDiv => {
      // Remove old listeners by cloning (prevents double-registration on re-render)
      const fresh = mcqDiv.cloneNode(true);
      mcqDiv.parentNode.replaceChild(fresh, mcqDiv);
      fresh.querySelectorAll('.quiz-opt').forEach(btn => {
        btn.addEventListener('click', function () {
          if (fresh.dataset.answered) return;
          fresh.dataset.answered = 'true';
          fresh.querySelectorAll('.quiz-opt').forEach(opt => {
            opt.disabled = true;
            if (opt.dataset.correct === 'true') {
              opt.style.cssText += 'background:rgba(5,150,105,0.2);border-color:#059669;color:#10b981;font-weight:600;';
              opt.innerHTML += ' ✓';
            } else if (opt === btn && opt.dataset.correct !== 'true') {
              opt.style.cssText += 'background:rgba(239,68,68,0.15);border-color:#ef4444;color:#ef4444;';
              opt.innerHTML += ' ✗';
            }
          });
          const explanation = fresh.querySelector('.quiz-explanation');
          if (explanation) explanation.style.display = 'block';
        });
      });
    });
  });
}

function saveContentAsNote(data, subject) {
  const noteBody = [
    `# ${subject.name} — Complete Study Content`,
    `> Level: ${data.level} | Generated by StudyMind AI with Wikipedia + Groq`,
    '',
    '## Introduction',
    data.intro || '',
    '',
    '## Study Phases',
    stripHtml(data.phases_html || ''),
    '',
    '## Key Concepts',
    stripHtml(data.concepts_html || ''),
    '',
    '## Resources',
    stripHtml(data.resources_html || '')
  ].join('\n');

  fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: ` ${subject.name} — Full Content`, body: noteBody })
  })
  .then(r => r.json())
  .then(saved => {
    state.notes.unshift(saved);
    renderNotesList();
    showToast('Saved as note! Check Notes tab.', 'success');
  })
  .catch(() => showToast('Failed to save note', 'error'));
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getSubjectEmoji(name) {
  const n = name.toLowerCase();
  if (n.includes('math') || n.includes('calculus') || n.includes('algebra')) return '🧮';
  if (n.includes('physics')) return '⚛️';
  if (n.includes('chemistry') || n.includes('chem')) return '🧪';
  if (n.includes('biology') || n.includes('bio')) return '🧬';
  if (n.includes('history')) return '📜';
  if (n.includes('english') || n.includes('literature')) return '📚';
  if (n.includes('computer') || n.includes('programming') || n.includes('code')) return '💻';
  if (n.includes('machine learning') || n.includes('ai') || n.includes('deep learning')) return '🤖';
  if (n.includes('economics') || n.includes('finance')) return '📈';
  if (n.includes('psychology')) return '🧠';
  if (n.includes('geography') || n.includes('geo')) return '🌍';
  if (n.includes('art') || n.includes('design')) return '🎨';
  if (n.includes('music')) return '🎵';
  if (n.includes('language') || n.includes('arabic') || n.includes('french') || n.includes('spanish')) return '🗣️';
  if (n.includes('law') || n.includes('legal')) return '⚖️';
  if (n.includes('medicine') || n.includes('medical')) return '🩺';
  return '📝';
}

function triggerCustomQuizGeneration(subject) {
  const genBtn = document.getElementById('generateCustomQuizBtn');
  const numSelect = document.getElementById('quizNumQuestions');
  const styleSelect = document.getElementById('quizQuestionStyle');
  const contentArea = document.getElementById('quizContentArea');
  
  if (!genBtn || !contentArea) return;
  
  genBtn.disabled = true;
  const originalText = genBtn.innerHTML;
  genBtn.textContent = 'Generating Quiz...';
  contentArea.innerHTML = `
    <div style="text-align:center;padding:40px 20px;">
      <div class="content-loading-anim" style="margin-bottom:15px;display:inline-block;">
        <div class="load-ring"></div>
      </div>
      <p style="color:var(--text-muted);font-size:0.9em;margin:0;">Creating customizable practice questions using Assessment Designer Agent...</p>
    </div>
  `;
  
  const subjectName = subject.name || subject;
  
  fetch('/api/quiz/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: subjectName,
      level: contentState.activeLevel,
      num_questions: numSelect ? numSelect.value : 10,
      question_style: styleSelect ? styleSelect.value : 'mixed'
    })
  })
  .then(r => r.json())
  .then(res => {
    genBtn.disabled = false;
    genBtn.innerHTML = originalText;
    if (res.error) {
      showToast('Error: ' + res.error, 'error');
      contentArea.innerHTML = '<div class="empty-state small"><p>Failed to generate quiz. Try again.</p></div>';
      return;
    }
    contentArea.innerHTML = res.quiz_html;
    setupContentQuiz();
    showToast('New practice quiz generated!', 'success');
  })
  .catch(err => {
    genBtn.disabled = false;
    genBtn.innerHTML = originalText;
    contentArea.innerHTML = '<div class="empty-state small"><p>Error connecting to quiz server.</p></div>';
    showToast('Failed to connect to quiz server.', 'error');
  });
}

