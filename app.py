import os
os.environ["PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION"] = "python"

from flask import Flask, render_template, request, jsonify, g
import sqlite3
from groq import Groq
from dotenv import load_dotenv
from datetime import datetime, timedelta
import json
import random
import threading
import time
import urllib.request
import urllib.parse
import re
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.jobstores.base import JobLookupError
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
import atexit

load_dotenv()

app = Flask(__name__)

api_key = os.getenv("GROQ_API_KEY")
groq_client = Groq(api_key=api_key) if api_key else None

# ─────────────────────────────────────────
# AGENT INFRASTRUCTURE
# ─────────────────────────────────────────

# ─────────────────────────────────────────
# AGENT EXTERNAL TOOLS
# ─────────────────────────────────────────

def db_query(sql_query: str) -> str:
    """Executes a read-only SQL query against the SQLite database and returns the result."""
    lower_query = sql_query.lower()
    if any(forbidden in lower_query for forbidden in ['drop', 'delete', 'update', 'insert', 'alter', 'create']):
        return "Error: Write operations not allowed via db_query. Use specific write tools."
    try:
        conn = get_db_connection()
        rows = conn.execute(sql_query).fetchall()
        conn.close()
        return str([dict(r) for r in rows])
    except Exception as e:
        return f"Database error: {str(e)}"

def search_web(query: str) -> str:
    """Performs a real web search for external content using Wikipedia. Returns text snippets."""
    try:
        url = f"https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={urllib.parse.quote(query)}&utf8=&format=json"
        req = urllib.request.Request(url, headers={'User-Agent': 'StudyMindBot/1.0'})
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8'))
            
        results = data.get('query', {}).get('search', [])
        if not results:
            return f"No web results found for '{query}'."
            
        snippets = []
        for r in results[:3]:
            # Clean HTML tags from snippet
            clean_snippet = re.sub('<[^<]+>', '', r.get('snippet', ''))
            snippets.append(f"- {r.get('title')}: {clean_snippet}")
            
        return f"Web Results for '{query}':\n" + "\n".join(snippets)
    except Exception as e:
        return f"Web search failed: {str(e)}"

def write_study_note(title: str, content: str) -> str:
    """Saves a new study note directly to the database."""
    try:
        conn = get_db_connection()
        conn.execute('INSERT INTO notes (title, body) VALUES (?, ?)', (title, content))
        conn.commit()
        conn.close()
        return f"Successfully saved note: {title}"
    except Exception as e:
        return f"Error saving note: {str(e)}"

def send_student_email(subject: str, message: str) -> str:
    """Sends a real email to the student using SMTP if configured. Falls back to DB notification."""
    try:
        # 1. Always log as notification for the UI
        conn = get_db_connection()
        conn.execute('INSERT INTO notifications (message, type) VALUES (?, ?)', 
                     (f" EMAIL: {subject} - {message}", "warning"))
        conn.commit()
        conn.close()
        
        # 2. Get student email
        try:
            from flask import request, g
            if request:
                profile_id = request.headers.get('X-Profile-ID', '1')
            else:
                profile_id = getattr(g, 'profile_id', '1')
        except RuntimeError:
            from flask import g
            try:
                profile_id = getattr(g, 'profile_id', '1')
            except RuntimeError:
                profile_id = '1'
            
        master_conn = get_master_db_connection()
        row = master_conn.execute('SELECT email FROM profile WHERE id=?', (profile_id,)).fetchone()
        master_conn.close()
        
        student_email = row['email'] if row and row['email'] else os.getenv("DEFAULT_STUDENT_EMAIL")
        
        # 3. Attempt real SMTP delivery
        smtp_server = os.getenv("SMTP_SERVER")
        smtp_port = os.getenv("SMTP_PORT", "587")
        smtp_user = os.getenv("SMTP_USERNAME")
        smtp_pass = os.getenv("SMTP_PASSWORD")
        
        if smtp_server and smtp_user and smtp_pass and student_email:
            msg = MIMEMultipart()
            msg['From'] = smtp_user
            msg['To'] = student_email
            msg['Subject'] = f"StudyMind AI: {subject}"
            msg.attach(MIMEText(message, 'plain'))
            
            server = smtplib.SMTP(smtp_server, int(smtp_port))
            server.starttls()
            server.login(smtp_user, smtp_pass)
            server.send_message(msg)
            server.quit()
            return f"Real email delivered to {student_email}."
            
        return "Email simulated as DB notification (SMTP not fully configured)."
    except Exception as e:
        return f"Failed to send real email: {str(e)}"

AGENT_CALLABLE_TOOLS = [db_query, search_web, write_study_note, send_student_email]

GROQ_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "db_query",
            "description": "Executes a read-only SQL query against the SQLite database and returns the result.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sql_query": {"type": "string", "description": "The SQL query to execute."}
                },
                "required": ["sql_query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": "Performs a real web search for external content using DuckDuckGo. Returns text snippets.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The search query."}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_study_note",
            "description": "Saves a new study note directly to the database.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The title of the note."},
                    "content": {"type": "string", "description": "The content of the note."}
                },
                "required": ["title", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "send_student_email",
            "description": "Sends a real email to the student using SMTP.",
            "parameters": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string", "description": "The email subject."},
                    "message": {"type": "string", "description": "The email message."}
                },
                "required": ["subject", "message"]
            }
        }
    }
]

TOOL_MAP = {
    "db_query": db_query,
    "search_web": search_web,
    "write_study_note": write_study_note,
    "send_student_email": send_student_email
}


class AgentTool:
    """Defines what actions an agent is permitted to take."""
    def __init__(self, db_write=False, notify=False, reschedule=False, critique=False):
        self.db_write = db_write
        self.notify = notify
        self.reschedule = reschedule
        self.critique = critique


class AIAgent:
    """Agent with persistent memory, tool access, and reasoning logs."""

    def __init__(self, name, role, instructions, tools: AgentTool = None, callable_tools=None):
        self.name = name
        self.role = role
        self.instructions = instructions
        self.tools = tools or AgentTool()
        self.callable_tools = callable_tools or []
        
        if self.callable_tools:
            # model configuration goes into execute
            pass
        else:
            pass

    def execute(self, task, log_reasoning=True, memory_keys=None):
        """
        Execute a task. Automatically injects relevant past memories
        into the prompt so the agent is NOT stateless.
        memory_keys: list of memory keys to load and inject.
        """
        # 1. Load relevant memories and inject into prompt
        memory_context = ""
        if memory_keys:
            memories = {k: self.recall_memory(k) for k in memory_keys if self.recall_memory(k)}
            if memories:
                mem_lines = "\n".join(f"  - {k}: {v}" for k, v in memories.items())
                memory_context = f"\n\n[Your Memory — what you knew before]:\n{mem_lines}"

        # Always load 'last_action' and 'summary' if they exist
        for key in ('last_action', 'summary'):
            val = self.recall_memory(key)
            if val and key not in (memory_keys or []):
                memory_context += f"\n  - {key}: {val}"

        prompt = (
            f"System: You are {self.name}, {self.role}.\n"
            f"Instructions: {self.instructions}\n"
            f"{memory_context}\n\n"
            f"CRITICAL: You MUST structure your response into exactly two parts:\n"
            f"1. A <reasoning>...</reasoning> block where you log your chain of thought, "
            f"explaining your analysis, constraints checked, and why you are choosing the action.\n"
            f"2. An <output>...</output> block containing ONLY the final expected result.\n\n"
            f"Current Task:\n{task}"
        )

        tool_logs = []
        raw_text_blocks = []

        if not groq_client:
            return "API key not configured."

        # ── Model fallback chain ──
        CONTENT_MODELS = [
            'llama-3.1-8b-instant',   # fast, low-token, separate quota
            'gemma2-9b-it',            # Google model, separate quota
            'llama-3.3-70b-versatile', # full power (may be rate-limited)
        ]

        def _call_groq(msgs, tools_list=None, tool_choice_val=None, max_tokens=4096):
            last_err = None
            for model in CONTENT_MODELS:
                try:
                    kwargs = dict(model=model, messages=msgs, temperature=0.3, max_tokens=max_tokens)
                    if tools_list:
                        kwargs['tools'] = tools_list
                        kwargs['tool_choice'] = tool_choice_val or 'auto'
                    return groq_client.chat.completions.create(**kwargs)
                except Exception as e:
                    err_str = str(e)
                    if 'rate_limit' in err_str or '429' in err_str:
                        last_err = e
                        time.sleep(1)
                        continue
                    raise
            raise last_err

        messages = [{"role": "user", "content": prompt}]
        
        if self.callable_tools:
            callable_tool_names = [t.__name__ for t in self.callable_tools]
            active_tools = [t for t in GROQ_TOOLS if t["function"]["name"] in callable_tool_names]
            
            while True:
                response = _call_groq(messages, active_tools if active_tools else None,
                                      'auto' if active_tools else 'none')
                
                response_message = response.choices[0].message
                if response_message.content:
                    raw_text_blocks.append(response_message.content)
                    
                tool_calls = response_message.tool_calls
                if not tool_calls:
                    break
                    
                messages.append({
                    "role": "assistant",
                    "content": response_message.content,
                    "tool_calls": [{"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}} for tc in tool_calls]
                })
                
                for tool_call in tool_calls:
                    function_name = tool_call.function.name
                    function_to_call = TOOL_MAP.get(function_name)
                    if function_to_call:
                        try:
                            function_args = json.loads(tool_call.function.arguments)
                            function_response = function_to_call(**function_args)
                        except Exception as e:
                            function_response = str(e)
                    else:
                        function_response = "Function not found"
                        
                    tool_logs.append(f" Used Tool: {function_name}")
                    tool_logs.append(f"✓ Tool Result: executed")
                    
                    messages.append({
                        "tool_call_id": tool_call.id,
                        "role": "tool",
                        "name": function_name,
                        "content": str(function_response),
                    })
            raw_text = "\n".join(raw_text_blocks).strip()
        else:
            response = _call_groq(messages)
            raw_text = response.choices[0].message.content.strip() if response.choices[0].message.content else ""

        import re
        reasoning_match = re.search(r'<reasoning>(.*?)</reasoning>', raw_text, re.DOTALL | re.IGNORECASE)
        output_match = re.search(r'<output>(.*?)</output>', raw_text, re.DOTALL | re.IGNORECASE)

        reasoning_text = reasoning_match.group(1).strip() if reasoning_match else "No explicit reasoning provided. Raw response: " + raw_text[:200]
        
        # Robustly clean the result to hide the agent's thinking / reasoning blocks
        if output_match:
            result = output_match.group(1).strip()
            # Clean up outer quotes if wrapped around the output block
            if result.startswith('"') and result.endswith('"') and result.count('"') == 2:
                result = result[1:-1].strip()
            elif result.startswith("'") and result.endswith("'") and result.count("'") == 2:
                result = result[1:-1].strip()
        else:
            # Strip reasoning block and residual tags
            result = re.sub(r'<reasoning>.*?</reasoning>', '', raw_text, flags=re.DOTALL | re.IGNORECASE).strip()
            result = re.sub(r'</?reasoning>', '', result, flags=re.IGNORECASE).strip()
            result = re.sub(r'</?output>', '', result, flags=re.IGNORECASE).strip()
            
            # If the model didn't use tags but printed its chain of thought directly and ends with a quoted sentence
            quoted_matches = re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', result, re.DOTALL)
            if quoted_matches:
                last_quote = quoted_matches[-1].strip()
                if len(last_quote) >= 15 and result.strip().endswith(f'"{quoted_matches[-1]}"'):
                    result = last_quote
            
            # Clean up common header prefixes
            result = re.sub(r'^(insight|output|result|tip|response):\s*', '', result, flags=re.IGNORECASE).strip()
            
            # Clean up surrounding quotes
            if result.startswith('"') and result.endswith('"') and result.count('"') == 2:
                result = result[1:-1].strip()
            elif result.startswith("'") and result.endswith("'") and result.count("'") == 2:
                result = result[1:-1].strip()

        if tool_logs:
            reasoning_text += "\n\n--- Tool Usage Log ---\n" + "\n".join(tool_logs)

        # 2. Auto-save last action to memory
        self.save_memory('last_action', task[:300])
        self.save_memory('last_result', result[:300])
        self.save_memory('last_run', datetime.now().isoformat())

        if log_reasoning:
            _log_reasoning(self.name, task, reasoning_text)
        return result

    def recall_memory(self, key):
        return _get_agent_memory(self.name, key)

    def save_memory(self, key, value):
        _set_agent_memory(self.name, key, value)


# ─────────────────────────────────────────
# DATABASE
# ─────────────────────────────────────────

def get_master_db_connection():
    conn = sqlite3.connect('master.db')
    conn.row_factory = sqlite3.Row
    return conn

def init_master_db():
    conn = get_master_db_connection()
    conn.execute('''CREATE TABLE IF NOT EXISTS profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, email TEXT, institution TEXT,
        bio TEXT, level TEXT DEFAULT 'Beginner',
        goal TEXT DEFAULT 'Learn and grow',
        avatar_color TEXT DEFAULT '#7c3aed')''')
    if conn.execute('SELECT COUNT(*) FROM profile').fetchone()[0] == 0:
        conn.execute('INSERT INTO profile (name,email,institution,bio) VALUES (?,?,?,?)',
                     ('Student', 'student@example.com', 'Self Taught', 'Ready to learn!'))
    conn.commit()
    profs = conn.execute('SELECT id FROM profile').fetchall()
    conn.close()
    for p in profs:
        init_user_db(p['id'])

def get_db_connection():
    try:
        if request:
            profile_id = request.headers.get('X-Profile-ID', '1')
        else:
            profile_id = getattr(g, 'profile_id', '1')
    except RuntimeError:
        profile_id = getattr(g, 'profile_id', '1')
        
    db_name = 'database.db' if str(profile_id) == '1' else f'database_{profile_id}.db'
    conn = sqlite3.connect(db_name)
    conn.row_factory = sqlite3.Row
    return conn

def init_user_db(profile_id):
    db_name = 'database.db' if str(profile_id) == '1' else f'database_{profile_id}.db'
    conn = sqlite3.connect(db_name)
    conn.row_factory = sqlite3.Row

    conn.execute('''CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, body TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

    conn.execute('''CREATE TABLE IF NOT EXISTS subjects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, color TEXT, status TEXT DEFAULT 'active')''')

    conn.execute('''CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, date TEXT NOT NULL,
        time TEXT NOT NULL, duration INTEGER DEFAULT 60,
        completed INTEGER DEFAULT 0)''')

    conn.execute('''CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL, type TEXT DEFAULT 'info',
        is_read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

    # ── New autonomous-system tables ──
    conn.execute('''CREATE TABLE IF NOT EXISTS agent_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL, key TEXT NOT NULL,
        value TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(agent_name, key))''')

    conn.execute('''CREATE TABLE IF NOT EXISTS agent_reasoning_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL, task TEXT,
        reasoning TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

    conn.execute('''CREATE TABLE IF NOT EXISTS orchestrator_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision TEXT NOT NULL, agents_invoked TEXT,
        outcome TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

    # ── Inter-agent communication tables ──
    conn.execute('''CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT,
        status TEXT DEFAULT 'pending',
        session_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

    conn.execute('''CREATE TABLE IF NOT EXISTS agent_workspace (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        written_by TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, key))''')

    # ── Progress tracking ──
    conn.execute('''CREATE TABLE IF NOT EXISTS performance_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        study_session_id INTEGER,
        event TEXT NOT NULL,
        subject TEXT,
        duration_minutes INTEGER DEFAULT 0,
        notes TEXT,
        logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')

    # ── Phase-synced content tracking ──
    conn.execute('''CREATE TABLE IF NOT EXISTS study_phases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_name TEXT NOT NULL,
        subject_id INTEGER,
        phase_number INTEGER NOT NULL,
        phase_name TEXT NOT NULL,
        phase_html TEXT,
        start_date TEXT,
        end_date TEXT,
        is_unlocked INTEGER DEFAULT 0,
        content_generated INTEGER DEFAULT 0,
        content_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(subject_name, phase_number))''')

    try:
        conn.execute('ALTER TABLE sessions ADD COLUMN completed INTEGER DEFAULT 0')
    except Exception:
        pass

    conn.commit()
    conn.close()

init_master_db()


# ─────────────────────────────────────────
# PHASE-SYNCED CONTENT ENGINE
# ─────────────────────────────────────────

def _parse_phases_from_html(html_plan):
    """Extract phase numbers and names from the AI-generated plan HTML."""
    phases = []
    seen = set()
    # Match 'Phase N: Title' anywhere in HTML text
    for m in re.finditer(r'Phase\s+(\d+)[:\s\u2014\-]+([^<\n]{3,80})', html_plan, re.IGNORECASE):
        num = int(m.group(1))
        raw_name = m.group(2).strip().rstrip('</h4>').strip()
        if num not in seen and num <= 10:
            seen.add(num)
            phases.append({'number': num, 'name': f"Phase {num}: {raw_name}"})
    # Sort and de-dup
    phases = sorted(phases, key=lambda x: x['number'])
    # Fallback if nothing parsed
    if not phases:
        phases = [
            {'number': 1, 'name': 'Phase 1: Foundation & Core Concepts'},
            {'number': 2, 'name': 'Phase 2: Deep Understanding & Application'},
            {'number': 3, 'name': 'Phase 3: Mastery, Practice & Exam Readiness'},
        ]
    return phases


def generate_phase_content_for_subject(subject_name, phase_number, level='detailed', profile_id=None):
    """
    Generates FULLY DETAILED educational content for a specific phase of a subject.
    Every topic and subtopic is explained in full — not just listed.
    Content is saved to the study_phases table and a success notification is added.
    """
    if not api_key:
        return None
    try:
        conn = get_db_connection()
        phase_row = conn.execute(
            'SELECT * FROM study_phases WHERE subject_name=? AND phase_number=?',
            (subject_name, phase_number)
        ).fetchone()
        conn.close()
        if not phase_row:
            return None

        phase_name = phase_row['phase_name']

        # Fetch diverse external context for this phase content
        wiki_articles = _fetch_wikipedia_content(subject_name, num_results=4)
        arxiv_articles = _fetch_arxiv_content(subject_name, num_results=3)
        wikibooks_articles = _fetch_wikibooks_content(subject_name, num_results=3)
        
        external_raw_parts = []
        if wiki_articles:
            external_raw_parts.append("Wikipedia:\n" + '\n\n'.join(f"=== {a['title']} ===\n{a['extract']}" for a in wiki_articles))
        if arxiv_articles:
            external_raw_parts.append("arXiv:\n" + '\n\n'.join(f"=== {a['title']} ===\n{a['extract']}" for a in arxiv_articles))
        if wikibooks_articles:
            external_raw_parts.append("Wikibooks:\n" + '\n\n'.join(f"=== {a['title']} ===\n{a['extract']}" for a in wikibooks_articles))
            
        wiki_raw = '\n\n'.join(external_raw_parts)[:9000]

        # ── Agent 1: Full phase content ──
        phase_agent = AIAgent(
            name=f"Phase{phase_number}ContentExpert",
            role="Expert Educational Content Creator",
            instructions=(
                f"You are writing COMPLETE, EXHAUSTIVE educational content for '{phase_name}' "
                f"of the subject '{subject_name}' at {level} level.\n"
                "This must read like a detailed textbook chapter — NOT a bullet list of topics.\n"
                "For EVERY topic and subtopic you must:\n"
                "  1. Write a full explanation (3-5 paragraphs minimum)\n"
                "  2. Explain WHY it matters and its real-world relevance\n"
                "  3. Provide at least one worked/concrete example\n"
                "  4. Highlight common pitfalls and misconceptions\n"
                "  5. Connect it to related topics in this phase\n\n"
                "Return pure HTML (no markdown code fences) structured as:\n"
                "<div class='phase-content-block'>\n"
                "  <div class='phase-hero'>\n"
                "    <h2>{Phase Name}</h2>\n"
                "    <p class='phase-overview'>{3-4 paragraph overview of the entire phase}</p>\n"
                "  </div>\n"
                "  <div class='topic-section' id='topic-N'>\n"
                "    <h3> Topic Name</h3>\n"
                "    <div class='topic-explanation'><p>Full explanation...</p><p>More detail...</p></div>\n"
                "    <div class='subtopics'>\n"
                "      <div class='subtopic'>\n"
                "        <h4>Subtopic Name</h4>\n"
                "        <p>Complete explanation with depth...</p>\n"
                "        <div class='example-box'><strong> Example:</strong> Detailed worked example...</div>\n"
                "        <div class='key-point'> <strong>Key Point:</strong> Critical takeaway...</div>\n"
                "        <div class='pitfall-box'> <strong>Common Mistake:</strong> What students get wrong...</div>\n"
                "      </div>\n"
                "      ... (3-5 subtopics per topic)\n"
                "    </div>\n"
                "  </div>\n"
                "  ... (minimum 6 topics)\n"
                "  <div class='phase-summary'>\n"
                "    <h3> Phase Summary — What You've Learned</h3>\n"
                "    <ul><li>...</li></ul>\n"
                "  </div>\n"
                "</div>\n"
                "Be EXTREMELY detailed. Cover everything. No placeholders. Return ONLY the HTML div."
            )
        )
        phase_html = phase_agent.execute(
            f"Subject: {subject_name}\nPhase: {phase_name}\nLevel: {level}\n"
            f"Context Data:\n{wiki_raw[:4500] if wiki_raw else 'Use expert knowledge.'}",
            log_reasoning=False
        )
        phase_html = phase_html.replace('```html', '').replace('```', '').strip()

        # ── Agent 2: Key concepts for this phase ──
        concepts_agent = AIAgent(
            name=f"Phase{phase_number}ConceptExpert",
            role="Domain Knowledge Expert",
            instructions=(
                f"Extract 8-12 critical concepts specifically for '{phase_name}' of '{subject_name}'.\n"
                "For EACH concept provide:\n"
                "- Full 3-4 sentence definition (academically precise)\n"
                "- Why it matters (practical importance)\n"
                "- A real-world analogy\n"
                "- Common misconception to avoid\n"
                "Return as HTML: <div class='concept-card'><h4>Term</h4>"
                "<p>Full definition...</p>"
                "<p><strong>Why it matters:</strong> ...</p>"
                "<p><em>Analogy:</em> ...</p>"
                "<p class='concept-warning'> <strong>Common mistake:</strong> ...</p></div>\n"
                "Return ONLY the HTML divs. No code fences."
            )
        )
        concepts_html = concepts_agent.execute(
            f"Subject: {subject_name}\nPhase: {phase_name}\nLevel: {level}\nContext Data:\n{wiki_raw[:3000] if wiki_raw else ''}",
            log_reasoning=False
        )
        concepts_html = concepts_html.replace('```html', '').replace('```', '').strip()

        # ── Agent 3: Phase-specific quiz ──
        quiz_agent = AIAgent(
            name=f"Phase{phase_number}QuizMaker",
            role="Educational Assessment Expert",
            instructions=(
                f"Create 8 quiz questions for '{phase_name}' of '{subject_name}'.\n"
                "5 MCQs + 3 open questions.\n"
                "MCQ format: <div class='quiz-mcq' data-q='N'>"
                "<p class='quiz-question'>Q{N}: question?</p>"
                "<div class='quiz-options'>"
                "<button class='quiz-opt' data-correct='false'>A) ...</button>"
                "<button class='quiz-opt' data-correct='true'>B) correct</button>"
                "<button class='quiz-opt' data-correct='false'>C) ...</button>"
                "<button class='quiz-opt' data-correct='false'>D) ...</button>"
                "</div><p class='quiz-explanation' style='display:none'>✅ Explanation...</p></div>\n"
                "Open: <div class='quiz-open'><p class='quiz-question'>Q{N}: ?</p>"
                "<p class='quiz-answer-hint'>💡 Key points: ...</p></div>\n"
                "Return ONLY the HTML. No code fences."
            )
        )
        quiz_html = quiz_agent.execute(
            f"Subject: {subject_name}\nPhase: {phase_name}",
            log_reasoning=False
        )
        quiz_html = quiz_html.replace('```html', '').replace('```', '').strip()

        # Save all sources in a unified format
        all_source_articles = []
        for a in wiki_articles:
            all_source_articles.append({'title': a['title'], 'url': a['url'], 'snippet': a['extract'][:300], 'source': 'Wikipedia'})
        for a in arxiv_articles:
            all_source_articles.append({'title': a['title'], 'url': a['url'], 'snippet': a['extract'][:300], 'source': 'arXiv'})
        for a in wikibooks_articles:
            all_source_articles.append({'title': a['title'], 'url': a['url'], 'snippet': a['extract'][:300], 'source': 'Wikibooks'})

        # Save to DB
        content_data = json.dumps({
            'phase_html': phase_html,
            'concepts_html': concepts_html,
            'quiz_html': quiz_html,
            'wiki_articles': [
                {'title': a['title'], 'url': a['url'], 'snippet': a['extract'][:300]}
                for a in wiki_articles
            ],
            'generated_at': datetime.now().isoformat()
        })
        conn = get_db_connection()
        conn.execute(
            'UPDATE study_phases SET content_generated=1, content_data=? '
            'WHERE subject_name=? AND phase_number=?',
            (content_data, subject_name, phase_number)
        )
        conn.commit()
        conn.close()
        _add_notification(f" Phase {phase_number} content ready for '{subject_name}'!", 'success')
        return json.loads(content_data)
    except Exception as e:
        print(f"[Phase Content] Error generating phase {phase_number} for {subject_name}: {e}")
        return None



# ─────────────────────────────────────────
# AGENT MEMORY HELPERS
# ─────────────────────────────────────────

def _get_agent_memory(agent_name, key):
    conn = get_db_connection()
    row = conn.execute(
        'SELECT value FROM agent_memory WHERE agent_name=? AND key=?',
        (agent_name, key)).fetchone()
    conn.close()
    return row['value'] if row else None


def _set_agent_memory(agent_name, key, value):
    conn = get_db_connection()
    conn.execute('''INSERT INTO agent_memory (agent_name, key, value, updated_at)
        VALUES (?,?,?,?) ON CONFLICT(agent_name,key)
        DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at''',
        (agent_name, key, str(value), datetime.now().isoformat()))
    conn.commit()
    conn.close()


def _log_reasoning(agent_name, task, reasoning):
    conn = get_db_connection()
    conn.execute(
        'INSERT INTO agent_reasoning_log (agent_name, task, reasoning) VALUES (?,?,?)',
        (agent_name, task[:500], reasoning[:4000]))
    conn.commit()
    conn.close()


def _log_orchestrator(decision, agents_invoked, outcome):
    conn = get_db_connection()
    conn.execute(
        'INSERT INTO orchestrator_log (decision, agents_invoked, outcome) VALUES (?,?,?)',
        (decision, agents_invoked, outcome))
    conn.commit()
    conn.close()


def _add_notification(message, ntype='info'):
    conn = get_db_connection()
    conn.execute('INSERT INTO notifications (message, type) VALUES (?,?)', (message, ntype))
    conn.commit()
    conn.close()


# ─────────────────────────────────────────
# AGENT MESSAGE BUS
# ─────────────────────────────────────────

class AgentMessageBus:
    """
    Persistent message queue. Agents post messages to each other by name.
    Messages are stored in the DB so they survive across requests.
    """

    @staticmethod
    def post(from_agent, to_agent, subject, body, session_id=None):
        conn = get_db_connection()
        conn.execute(
            'INSERT INTO agent_messages (from_agent,to_agent,subject,body,status,session_id) VALUES (?,?,?,?,?,?)',
            (from_agent, to_agent, subject, str(body)[:2000], 'pending', session_id)
        )
        conn.commit()
        conn.close()

    @staticmethod
    def consume(to_agent, session_id=None):
        """Read and mark as consumed all pending messages for an agent."""
        conn = get_db_connection()
        query = 'SELECT * FROM agent_messages WHERE to_agent=? AND status=?'
        params = [to_agent, 'pending']
        if session_id:
            query += ' AND session_id=?'
            params.append(session_id)
        rows = conn.execute(query + ' ORDER BY created_at ASC', params).fetchall()
        ids = [r['id'] for r in rows]
        if ids:
            conn.execute(
                f"UPDATE agent_messages SET status='consumed' WHERE id IN ({','.join('?'*len(ids))})",
                ids
            )
            conn.commit()
        conn.close()
        return [dict(r) for r in rows]

    @staticmethod
    def peek_all(session_id=None, limit=30):
        """Read recent messages without consuming — for UI display."""
        conn = get_db_connection()
        if session_id:
            rows = conn.execute(
                'SELECT * FROM agent_messages WHERE session_id=? ORDER BY created_at DESC LIMIT ?',
                (session_id, limit)).fetchall()
        else:
            rows = conn.execute(
                'SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?',
                (limit,)).fetchall()
        conn.close()
        return [dict(r) for r in rows]


class AgentWorkspace:
    """
    Shared key-value store scoped to a planning session.
    Any agent can read/write — this is the common blackboard.
    """

    @staticmethod
    def write(session_id, written_by, key, value):
        conn = get_db_connection()
        conn.execute(
            '''INSERT INTO agent_workspace (session_id,written_by,key,value,updated_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(session_id,key)
               DO UPDATE SET value=excluded.value, written_by=excluded.written_by,
                             updated_at=excluded.updated_at''',
            (session_id, written_by, key, str(value)[:4000], datetime.now().isoformat())
        )
        conn.commit()
        conn.close()

    @staticmethod
    def read(session_id, key):
        conn = get_db_connection()
        row = conn.execute(
            'SELECT value FROM agent_workspace WHERE session_id=? AND key=?',
            (session_id, key)).fetchone()
        conn.close()
        return row['value'] if row else None

    @staticmethod
    def read_all(session_id):
        conn = get_db_connection()
        rows = conn.execute(
            'SELECT * FROM agent_workspace WHERE session_id=? ORDER BY updated_at ASC',
            (session_id,)).fetchall()
        conn.close()
        return [dict(r) for r in rows]


# ─── Attach messaging methods to AIAgent ───

def _agent_send_message(self, to_agent, subject, body, session_id=None):
    AgentMessageBus.post(self.name, to_agent, subject, body, session_id)

def _agent_read_messages(self, session_id=None):
    return AgentMessageBus.consume(self.name, session_id)

def _agent_write_workspace(self, session_id, key, value):
    AgentWorkspace.write(session_id, self.name, key, value)

def _agent_read_workspace(self, session_id, key):
    return AgentWorkspace.read(session_id, key)

AIAgent.send_message     = _agent_send_message
AIAgent.read_messages    = _agent_read_messages
AIAgent.write_workspace  = _agent_write_workspace
AIAgent.read_workspace   = _agent_read_workspace

# ─────────────────────────────────────────
# PROGRESS MONITOR AGENT
# ─────────────────────────────────────────

class ProgressMonitorAgent:
    """
    Dedicated agent that reads performance_log data and produces
    a structured health report. Called by the Orchestrator each cycle.
    """
    NAME = "Progress Monitor"

    @staticmethod
    def build_report():
        """Read DB and return a structured dict of student performance data."""
        conn = get_db_connection()
        today    = datetime.now().strftime("%Y-%m-%d")
        week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")

        total     = conn.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
        done      = conn.execute('SELECT COUNT(*) FROM sessions WHERE completed=1').fetchone()[0]
        missed    = conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE date<? AND completed=0", (today,)).fetchone()[0]
        due_today = conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE date=? AND completed=0", (today,)).fetchone()[0]

        completions_week = conn.execute(
            "SELECT COUNT(*) FROM performance_log WHERE event='completed' AND logged_at>=?",
            (week_ago,)).fetchone()[0]
        skips_week = conn.execute(
            "SELECT COUNT(*) FROM performance_log WHERE event='skipped' AND logged_at>=?",
            (week_ago,)).fetchone()[0]
        minutes_row = conn.execute(
            "SELECT SUM(duration_minutes) FROM performance_log WHERE event='completed' AND logged_at>=?",
            (week_ago,)).fetchone()[0]
        minutes_week = minutes_row or 0

        subjects_done = conn.execute(
            "SELECT subject, COUNT(*) as cnt FROM performance_log "
            "WHERE event='completed' GROUP BY subject ORDER BY cnt DESC LIMIT 5"
        ).fetchall()
        recent_logs = conn.execute(
            'SELECT * FROM performance_log ORDER BY logged_at DESC LIMIT 10').fetchall()
            
        # Calculate Day Streak
        completed_dates = conn.execute(
            "SELECT DISTINCT date FROM sessions WHERE completed=1 ORDER BY date DESC"
        ).fetchall()
        
        dates_set = {datetime.strptime(r['date'], "%Y-%m-%d").date() for r in completed_dates}
        current_streak = 0
        streak_date = datetime.now().date()
        
        if streak_date in dates_set:
            current_streak += 1
            streak_date -= timedelta(days=1)
            while streak_date in dates_set:
                current_streak += 1
                streak_date -= timedelta(days=1)
        elif (streak_date - timedelta(days=1)) in dates_set:
            streak_date -= timedelta(days=1)
            while streak_date in dates_set:
                current_streak += 1
                streak_date -= timedelta(days=1)
                
        conn.close()

        completion_rate = round((done / total * 100), 1) if total else 0
        streak_risk = missed >= 3

        return {
            "total_sessions": total,
            "completed": done,
            "missed": missed,
            "due_today": due_today,
            "completion_rate": completion_rate,
            "completions_this_week": completions_week,
            "skips_this_week": skips_week,
            "minutes_studied_this_week": minutes_week,
            "top_subjects": [dict(r) for r in subjects_done],
            "streak_risk": streak_risk,
            "current_streak": current_streak,
            "recent_logs": [dict(r) for r in recent_logs],
        }

    @staticmethod
    def ai_analysis(report: dict):
        """Ask the AI to interpret the report and provide adaptive advice."""
        if not api_key:
            return "API key not configured."
        agent = AIAgent(
            name=ProgressMonitorAgent.NAME,
            role="Student Performance Analyst",
            instructions=(
                "Analyse the student's performance report. "
                "Identify the biggest risk (missed sessions, low completion, subject lag). "
                "Provide ONE specific, actionable recommendation in 2 sentences. "
                "Use tools if you need to look up data."
            ),
            tools=AgentTool(notify=True),
            callable_tools=AGENT_CALLABLE_TOOLS
        )
        summary = (
            f"Total:{report['total_sessions']} Completed:{report['completed']} "
            f"({report['completion_rate']}%) Missed:{report['missed']} Due today:{report['due_today']}\n"
            f"This week: {report['completions_this_week']} done, "
            f"{report['skips_this_week']} skipped, "
            f"{report['minutes_studied_this_week']}min studied\n"
            f"Streak risk: {report['streak_risk']}"
        )
        return agent.execute(summary, memory_keys=['last_result', 'summary'])


# ─────────────────────────────────────────────────────────────────────────────
# AUTONOMOUS SCHEDULER  —  ALL BACKGROUND JOBS LIVE HERE
# Uses APScheduler with a SQLite job store so jobs survive server restarts.
# ─────────────────────────────────────────────────────────────────────────────

# ── Shared in-process status (updated by every job run) ──
_scheduler_status = {
    "status": "idle",
    "last_run": None,
    "last_decision": "Scheduler not yet started",
}


def _orchestrator_decision_cycle(trigger_label="scheduled"):
    """
    Core autonomous decision loop — called by multiple APScheduler jobs.
    Reads student progress and autonomously dispatches specialist agents.
    """
    if not api_key:
        return

    _scheduler_status["status"] = "running"
    _scheduler_status["last_run"] = datetime.now().isoformat()

    try:
        report  = ProgressMonitorAgent.build_report()
        today   = datetime.now().strftime("%Y-%m-%d")
        now_hour = datetime.now().hour

        conn = get_db_connection()
        subjects = conn.execute('SELECT name FROM subjects LIMIT 5').fetchall()
        conn.close()
        subject_names = ", ".join(r['name'] for r in subjects) if subjects else "none"

        last_action        = _get_agent_memory('Orchestrator', 'last_action') or 'None'
        consecutive_misses = int(_get_agent_memory('Orchestrator', 'consecutive_misses') or 0)
        cycles_run         = int(_get_agent_memory('Orchestrator', 'cycles_run') or 0)

        consecutive_misses = consecutive_misses + 1 if report['missed'] > 0 else 0
        cycles_run += 1
        _set_agent_memory('Orchestrator', 'consecutive_misses', str(consecutive_misses))
        _set_agent_memory('Orchestrator', 'cycles_run', str(cycles_run))
        _set_agent_memory('Orchestrator', 'last_completion_rate', str(report['completion_rate']))
        _set_agent_memory('Orchestrator', 'last_check_date', today)

        context = (
            f"Date: {today} | Hour: {now_hour}:00 | Trigger: {trigger_label}\n"
            f"Subjects: {subject_names}\n"
            f"[Monitor] Total:{report['total_sessions']} Completed:{report['completed']} "
            f"Missed:{report['missed']} Rate:{report['completion_rate']}%\n"
            f"[Monitor] This week: {report['completions_this_week']} done, "
            f"{report['skips_this_week']} skipped, "
            f"{report['minutes_studied_this_week']}min studied\n"
            f"[Monitor] Streak risk: {report['streak_risk']}\n"
            f"[Memory] Last action: {last_action}\n"
            f"[Memory] Consecutive miss cycles: {consecutive_misses}"
        )

        decision_agent = AIAgent(
            name="Orchestrator",
            role="Autonomous Study System Brain",
            instructions=(
                "You are an autonomous orchestrator with memory. Use the Progress Monitor "
                "report to decide ONE action:\n"
                "1. MOTIVATE - student is doing well or needs encouragement\n"
                "2. RESCHEDULE - 3+ missed sessions or streak risk is True\n"
                "3. REVIEW_PLAN - completion rate <40% or skips exceed completions\n"
                "4. IDLE - on track, already acted recently\n"
                "Format: ACTION: <keyword> | REASON: <reason>\n"
                "You have access to tools. Feel free to use db_query to check current subjects or notes before deciding."
            ),
            tools=AgentTool(),
            callable_tools=AGENT_CALLABLE_TOOLS
        )
        decision_raw = decision_agent.execute(
            context, memory_keys=['last_action', 'consecutive_misses', 'last_completion_rate'])
        _scheduler_status["last_decision"] = decision_raw

        action = "IDLE"
        if "MOTIVATE"      in decision_raw.upper(): action = "MOTIVATE"
        elif "RESCHEDULE"  in decision_raw.upper(): action = "RESCHEDULE"
        elif "REVIEW_PLAN" in decision_raw.upper(): action = "REVIEW_PLAN"

        _set_agent_memory('Orchestrator', 'last_action_type', action)
        _set_agent_memory('Orchestrator', 'last_action_date', today)

        agents_used = ["Orchestrator", "Progress Monitor"]
        outcome = ""

        if action in ("RESCHEDULE", "REVIEW_PLAN") or report['streak_risk']:
            advice = ProgressMonitorAgent.ai_analysis(report)
            _add_notification(f" Monitor: {advice}", "warning" if report['streak_risk'] else "info")
            agents_used.append("Progress Monitor (AI)")

        if action == "MOTIVATE":
            coach = AIAgent(
                name="Motivational Coach", role="Student Motivator",
                instructions="Write a 1-2 sentence motivating message. Avoid repeating yourself. Feel free to use the search_web tool for a cool motivational quote, or send_student_email to send it directly to their inbox.",
                tools=AgentTool(notify=True),
                callable_tools=AGENT_CALLABLE_TOOLS)
            msg = coach.execute(context, memory_keys=['last_result'])
            coach.save_memory('summary', f"Motivated on {today}: {msg[:100]}")
            _add_notification(f" Coach: {msg}", "info")
            agents_used.append("Motivational Coach")
            outcome = "Sent motivational message."

        elif action == "RESCHEDULE":
            reschedule_agent = AIAgent(
                name="Rescheduler", role="Session Recovery Expert",
                instructions="Student missed sessions. Write a short, specific advisory referencing consecutive misses from memory. Use tools to see what they missed or send_student_email to alert them.",
                tools=AgentTool(notify=True, reschedule=True),
                callable_tools=AGENT_CALLABLE_TOOLS)
            msg = reschedule_agent.execute(context, memory_keys=['last_result', 'summary'])
            reschedule_agent.save_memory('summary', f"Alert sent {today}. Misses: {report['missed']}")
            _add_notification(f" Rescheduler: {msg}", "warning")
            agents_used.append("Rescheduler")
            outcome = f"Alerted student. {report['missed']} missed, streak_risk={report['streak_risk']}."

        elif action == "REVIEW_PLAN":
            critic = AIAgent(
                name="Plan Critic", role="Curriculum Quality Reviewer",
                instructions="Review student situation. Give NEW advice, check memory for what you said before. Feel free to search the web for study techniques using search_web, or write a note to the DB.",
                tools=AgentTool(notify=True, critique=True),
                callable_tools=AGENT_CALLABLE_TOOLS)
            msg = critic.execute(context, memory_keys=['last_result', 'summary'])
            critic.save_memory('summary', f"Reviewed {today}: {msg[:100]}")
            _add_notification(f" Plan Review: {msg}", "info")
            agents_used.append("Plan Critic")
            outcome = "Sent plan review advisory."

        else:
            outcome = "System on track — no action needed."

        _log_orchestrator(
            decision=decision_raw,
            agents_invoked=", ".join(agents_used),
            outcome=outcome
        )

    except Exception as e:
        _log_orchestrator("ERROR", "Orchestrator", str(e))
    finally:
        _scheduler_status["status"] = "idle"


# ── Individual named job functions (APScheduler requires top-level callables) ──

def run_for_all_profiles(func):
    import functools
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        conn = get_master_db_connection()
        try:
            profs = conn.execute('SELECT id FROM profile').fetchall()
        except Exception:
            profs = [{'id': 1}]
        conn.close()
        for p in profs:
            with app.app_context():
                g.profile_id = str(p['id'])
                func(*args, **kwargs)
    return wrapper

@run_for_all_profiles
def job_hourly_decision():
    """Runs every hour: core autonomous decision cycle."""
    _orchestrator_decision_cycle("hourly")


@run_for_all_profiles
def job_morning_briefing():
    """
    Runs at 08:00 every morning.
    Sends a daily study plan summary and checks for due sessions.
    """
    if not api_key:
        return
    try:
        today = datetime.now().strftime("%Y-%m-%d")
        conn = get_db_connection()
        due_today = conn.execute(
            "SELECT * FROM sessions WHERE date=? AND completed=0", (today,)
        ).fetchall()
        conn.close()

        session_list = ", ".join(r['title'] for r in due_today) if due_today else "none"
        briefing_agent = AIAgent(
            name="Morning Briefer", role="Daily Study Coach",
            instructions=(
                "Write a warm, energising morning briefing (2-3 sentences). "
                "Mention today's study sessions if any. Encourage the student to start strong. "
                "Use search_web for a quote, or send_student_email if there are many sessions."
            ),
            tools=AgentTool(notify=True),
            callable_tools=AGENT_CALLABLE_TOOLS
        )
        msg = briefing_agent.execute(
            f"Today is {today}. Sessions due today: {session_list}.",
            memory_keys=['last_result']
        )
        _add_notification(f" Morning Brief: {msg}", "info")
        _log_orchestrator(
            decision="MORNING_BRIEFING",
            agents_invoked="Morning Briefer",
            outcome=f"Briefing sent. {len(due_today)} sessions due today."
        )
    except Exception as e:
        _log_orchestrator("ERROR", "Morning Briefer", str(e))


@run_for_all_profiles
def job_evening_reminder():
    """
    Runs at 18:00 every evening.
    Checks for sessions due today that are still incomplete and nudges the student.
    """
    if not api_key:
        return
    try:
        today = datetime.now().strftime("%Y-%m-%d")
        conn = get_db_connection()
        pending = conn.execute(
            "SELECT * FROM sessions WHERE date=? AND completed=0", (today,)
        ).fetchall()
        conn.close()

        if not pending:
            _add_notification(" Evening Check: All sessions for today are complete! Great job.", "info")
            _log_orchestrator(
                decision="EVENING_REMINDER",
                agents_invoked="Evening Reminder",
                outcome="All today's sessions complete — positive notification sent."
            )
            return

        session_list = ", ".join(r['title'] for r in pending)
        reminder_agent = AIAgent(
            name="Evening Reminder", role="Accountability Coach",
            instructions=(
                "Write a friendly but firm 2-sentence evening reminder. "
                "The student still has pending sessions. Motivate them to finish today. "
                "Use db_query to find exactly what they missed."
            ),
            tools=AgentTool(notify=True),
            callable_tools=AGENT_CALLABLE_TOOLS
        )
        msg = reminder_agent.execute(
            f"Pending sessions tonight: {session_list}",
            memory_keys=['last_result']
        )
        _add_notification(f" Evening Reminder: {msg}", "warning")
        _log_orchestrator(
            decision="EVENING_REMINDER",
            agents_invoked="Evening Reminder",
            outcome=f"Reminder sent for {len(pending)} pending sessions."
        )
    except Exception as e:
        _log_orchestrator("ERROR", "Evening Reminder", str(e))


@run_for_all_profiles
def job_midnight_reschedule():
    """
    Runs at 00:05 every night.
    Automatically detects sessions that were missed yesterday and reschedules
    them to the next available slot — no user action needed.
    """
    if not api_key:
        return
    try:
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        tomorrow  = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")

        conn = get_db_connection()
        missed = conn.execute(
            "SELECT * FROM sessions WHERE date=? AND completed=0", (yesterday,)
        ).fetchall()

        if not missed:
            conn.close()
            return

        rescheduled = []
        for row in missed:
            # Reschedule to tomorrow at the same time
            conn.execute(
                'UPDATE sessions SET date=? WHERE id=?',
                (tomorrow, row['id'])
            )
            rescheduled.append(row['title'])

        conn.commit()
        conn.close()

        reschedule_agent = AIAgent(
            name="Auto Rescheduler", role="Autonomous Session Recovery Agent",
            instructions=(
                "Write a concise 2-sentence notification telling the student that "
                "missed sessions have been automatically moved to tomorrow. Be supportive."
            ),
            tools=AgentTool(notify=True, reschedule=True),
            callable_tools=AGENT_CALLABLE_TOOLS
        )
        session_list = ", ".join(rescheduled)
        msg = reschedule_agent.execute(
            f"Automatically rescheduled to {tomorrow}: {session_list}",
            memory_keys=['last_result']
        )
        _add_notification(f" Auto-Reschedule: {msg}", "warning")
        _log_orchestrator(
            decision="AUTO_RESCHEDULE",
            agents_invoked="Auto Rescheduler",
            outcome=f"Rescheduled {len(rescheduled)} sessions from {yesterday} → {tomorrow}."
        )
    except Exception as e:
        _log_orchestrator("ERROR", "Auto Rescheduler", str(e))


@run_for_all_profiles
def job_startup_scan():
    """
    Runs once at startup (30 s after server boot).
    Performs an immediate health check and notifies the student that
    the autonomous system is active.
    """
    try:
        report = ProgressMonitorAgent.build_report()
        missed_count = report['missed']
        due_today    = report['due_today']
        rate         = report['completion_rate']
        risk         = report['streak_risk']

        summary = (
            f"StudyMind AI is online. Completion rate: {rate}%. "
            f"Sessions due today: {due_today}. "
            f"Missed sessions: {missed_count}."
            f"{'  Streak at risk!' if risk else ''}"
        )
        _add_notification(f" System Online: {summary}", "info")
        _log_orchestrator(
            decision="STARTUP_SCAN",
            agents_invoked="Progress Monitor",
            outcome=f"Startup health check. Rate:{rate}% Missed:{missed_count} DueToday:{due_today}."
        )
        _scheduler_status["last_run"] = datetime.now().isoformat()
        _scheduler_status["last_decision"] = f"STARTUP_SCAN | Rate:{rate}% Missed:{missed_count}"

        # If there are already missed sessions, kick off a decision cycle
        if missed_count >= 3 or risk:
            _orchestrator_decision_cycle("startup_risk_detected")
    except Exception as e:
        _log_orchestrator("ERROR", "Startup Scanner", str(e))

    # Safe self-removal — ignore if already removed by APScheduler
    try:
        _scheduler.remove_job('startup_scan')
    except Exception:
        pass


@run_for_all_profiles
def job_phase_unlock_check():
    """Runs daily at 00:10 UTC — auto-unlocks next phase when end_date passes."""
    try:
        today = datetime.now().strftime('%Y-%m-%d')
        conn  = get_db_connection()
        subjects = conn.execute('SELECT DISTINCT subject_name FROM study_phases').fetchall()
        conn.close()
        for subj_row in subjects:
            sname = subj_row['subject_name']
            conn  = get_db_connection()
            phases = conn.execute(
                'SELECT * FROM study_phases WHERE subject_name=? ORDER BY phase_number',
                (sname,)
            ).fetchall()
            conn.close()
            for phase in phases:
                if phase['is_unlocked'] and phase['end_date'] and phase['end_date'] < today:
                    next_num = phase['phase_number'] + 1
                    conn = get_db_connection()
                    nxt = conn.execute(
                        'SELECT * FROM study_phases WHERE subject_name=? AND phase_number=?',
                        (sname, next_num)
                    ).fetchone()
                    if nxt and not nxt['is_unlocked']:
                        conn.execute(
                            'UPDATE study_phases SET is_unlocked=1 '
                            'WHERE subject_name=? AND phase_number=?',
                            (sname, next_num)
                        )
                        conn.commit()
                        conn.close()
                        _add_notification(
                            f"Phase {next_num} auto-unlocked for '{sname}'! Content generating...",
                            'success'
                        )
                        generate_phase_content_for_subject(sname, next_num)
                    else:
                        conn.close()
    except Exception as e:
        print(f"[Phase Unlock Job] Error: {e}")


# ── Bootstrap APScheduler ──

def _start_scheduler():
    """
    Creates and starts the APScheduler BackgroundScheduler with a
    SQLite job store so jobs are persisted across restarts.
    Guards against Flask's debug reloader double-start.
    """
    # In debug mode Flask spawns a child process (WERKZEUG_RUN_MAIN=true).
    # We only want to start the scheduler in the real process.
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        pass  # child process — allow
    elif os.environ.get("WERKZEUG_RUN_MAIN") is not None:
        return None  # parent watcher process — skip

    jobstores = {
        'default': SQLAlchemyJobStore(url='sqlite:///apscheduler_jobs.db')
    }
    scheduler = BackgroundScheduler(jobstores=jobstores, timezone='UTC')

    # 1. Hourly decision cycle
    scheduler.add_job(
        job_hourly_decision,
        trigger=IntervalTrigger(hours=1),
        id='hourly_decision',
        name='Hourly Decision Cycle',
        replace_existing=True
    )

    # 2. Morning briefing — 08:00 UTC every day
    scheduler.add_job(
        job_morning_briefing,
        trigger=CronTrigger(hour=8, minute=0),
        id='morning_briefing',
        name='Morning Briefing',
        replace_existing=True
    )

    # 3. Evening reminder — 18:00 UTC every day
    scheduler.add_job(
        job_evening_reminder,
        trigger=CronTrigger(hour=18, minute=0),
        id='evening_reminder',
        name='Evening Session Reminder',
        replace_existing=True
    )

    # 4. Midnight auto-reschedule — 00:05 UTC every day
    scheduler.add_job(
        job_midnight_reschedule,
        trigger=CronTrigger(hour=0, minute=5),
        id='midnight_reschedule',
        name='Midnight Auto-Reschedule',
        replace_existing=True
    )

    # 5. One-shot startup scan — fires 30 s after server boot
    scheduler.add_job(
        job_startup_scan,
        trigger='date',
        run_date=datetime.now() + timedelta(seconds=30),
        id='startup_scan',
        name='Startup Health Scan',
        replace_existing=True,
        misfire_grace_time=300
    )

    # 6. Daily phase unlock check — 00:10 UTC
    scheduler.add_job(
        job_phase_unlock_check,
        trigger=CronTrigger(hour=0, minute=10),
        id='phase_unlock_check',
        name='Daily Phase Unlock Check',
        replace_existing=True
    )

    if not scheduler.running:
        scheduler.start()
    atexit.register(lambda: scheduler.shutdown(wait=False))
    return scheduler


_scheduler = _start_scheduler()


# ── Compatibility shim: keeps /api/orchestrator/run working ──
class _OrchestratorShim:
    """Thin wrapper so existing frontend code keeps working unchanged."""

    @property
    def status(self):
        return _scheduler_status["status"]

    @property
    def last_run(self):
        return _scheduler_status["last_run"]

    @property
    def last_decision(self):
        return _scheduler_status["last_decision"]

    def run_now(self, profile_id='1'):
        def target():
            with app.app_context():
                from flask import g
                g.profile_id = profile_id
                _orchestrator_decision_cycle("manual_trigger")
        threading.Thread(
            target=target,
            daemon=True
        ).start()


orchestrator = _OrchestratorShim()


# ─────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/proposal')
def proposal():
    try:
        with open('project_proposal.md', 'r', encoding='utf-8') as f:
            content = f.read()
        return render_template('proposal.html', content=content)
    except Exception as e:
        return str(e)


# ── Orchestrator API ──
@app.route('/api/orchestrator/status')
def orchestrator_status():
    logs = []
    try:
        conn = get_db_connection()
        rows = conn.execute(
            'SELECT * FROM orchestrator_log ORDER BY created_at DESC LIMIT 10').fetchall()
        logs = [dict(r) for r in rows]
        conn.close()
    except Exception:
        pass

    # Include next-run times from APScheduler
    scheduled_jobs = []
    if _scheduler and _scheduler.running:
        for job in _scheduler.get_jobs():
            next_run = job.next_run_time
            scheduled_jobs.append({
                "id":   job.id,
                "name": job.name,
                "next_run": next_run.isoformat() if next_run else None,
            })

    return jsonify({
        "status":          orchestrator.status,
        "last_run":        orchestrator.last_run,
        "last_decision":   orchestrator.last_decision,
        "logs":            logs,
        "scheduled_jobs":  scheduled_jobs,
    })


@app.route('/api/scheduler/jobs')
def get_scheduler_jobs():
    """Returns all APScheduler jobs with their next-run timestamps."""
    if not _scheduler or not _scheduler.running:
        return jsonify({"running": False, "jobs": []})
    jobs = []
    for job in _scheduler.get_jobs():
        next_run = job.next_run_time
        jobs.append({
            "id":       job.id,
            "name":     job.name,
            "next_run": next_run.isoformat() if next_run else None,
        })
    return jsonify({"running": True, "jobs": jobs})


@app.route('/api/orchestrator/run', methods=['POST'])
def trigger_orchestrator():
    from flask import request
    profile_id = request.headers.get('X-Profile-ID', '1')
    orchestrator.run_now(profile_id)
    return jsonify({"success": True, "message": "Orchestrator cycle triggered."})


# ── Agent Reasoning Logs ──
@app.route('/api/agent_logs')
def agent_logs():
    conn = get_db_connection()
    rows = conn.execute(
        'SELECT * FROM agent_reasoning_log ORDER BY created_at DESC LIMIT 20').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


# ── Message Bus API ──
@app.route('/api/agent_messages')
def get_agent_messages():
    session_id = request.args.get('session_id')
    msgs = AgentMessageBus.peek_all(session_id=session_id, limit=50)
    return jsonify(msgs)


# ── Shared Workspace API ──
@app.route('/api/agent_workspace')
def get_agent_workspace():
    session_id = request.args.get('session_id')
    if not session_id:
        # Return latest sessions
        conn = get_db_connection()
        rows = conn.execute(
            'SELECT * FROM agent_workspace ORDER BY updated_at DESC LIMIT 30').fetchall()
        conn.close()
        return jsonify([dict(r) for r in rows])
    return jsonify(AgentWorkspace.read_all(session_id))


# ── Session Completion (with performance logging) ──
@app.route('/api/sessions/<int:session_id>/complete', methods=['POST'])
def complete_session(session_id):
    data = request.json or {}
    event  = data.get('event', 'completed')   # 'completed' | 'skipped'
    notes  = data.get('notes', '')

    conn = get_db_connection()
    # Mark session
    conn.execute('UPDATE sessions SET completed=1 WHERE id=?', (session_id,))

    # Fetch session info for the log
    row = conn.execute('SELECT * FROM sessions WHERE id=?', (session_id,)).fetchone()
    subject  = row['title'] if row else 'Unknown'
    duration = row['duration'] if row else 0

    # Write to performance_log
    conn.execute(
        'INSERT INTO performance_log (study_session_id,event,subject,duration_minutes,notes) VALUES (?,?,?,?,?)',
        (session_id, event, subject, duration if event == 'completed' else 0, notes)
    )
    conn.commit()
    conn.close()

    # Notify Progress Monitor to re-evaluate
    AgentMessageBus.post(
        'Student', 'Progress Monitor',
        'session_event',
        f"Session '{subject}' marked as '{event}'. Duration: {duration}min."
    )
    return jsonify({"success": True, "event": event})


# ── Progress / Performance API ──
@app.route('/api/progress')
def get_progress():
    report = ProgressMonitorAgent.build_report()
    return jsonify(report)


@app.route('/api/progress/ai_analysis', methods=['GET'])
def get_progress_ai_analysis():
    if not api_key:
        return jsonify({"analysis": "Configure Groq API key to enable AI analysis."})
    report = ProgressMonitorAgent.build_report()
    analysis = ProgressMonitorAgent.ai_analysis(report)
    return jsonify({"analysis": analysis, "report": report})


# ── AI Plan Generation — Message-Bus Architecture ──
@app.route('/api/generate_plan', methods=['POST'])
def generate_plan():
    if not api_key:
        return jsonify({"error": "Groq API key not configured"}), 500

    data = request.json
    topic      = data.get('topic', 'General Studies')
    start_date = data.get('start_date', '')
    goal_date  = data.get('goal_date', 'Unknown')
    hours      = data.get('hours', 3)
    level      = data.get('level', 'beginner')
    objectives = data.get('objectives', '')
    today      = datetime.now().strftime("%Y-%m-%d")
    effective_start = start_date if start_date else today
    date_context = f"Start: {effective_start} | End: {goal_date}" if start_date else f"Goal: {goal_date} (Today: {today})"

    # Each plan gets a unique session ID — scopes all messages and workspace entries
    import uuid
    session_id = str(uuid.uuid4())[:8]

    curriculum_designer = AIAgent(
        name="Curriculum Designer", role="Expert Educational Planner",
        instructions="Create 3 concise study phases. Return ONLY HTML: <div class='plan-item'><h4>Phase X: Title</h4><p>Desc</p><ul><li>Topic</li></ul></div>. Use tools like search_web to find real-world techniques.",
        tools=AgentTool(db_write=True),
        callable_tools=AGENT_CALLABLE_TOOLS)

    critic = AIAgent(
        name="Plan Critic", role="Quality Assurance Reviewer",
        instructions="Review the curriculum HTML. Reply 'APPROVED' or 'REVISE: <reason>'. Use db_query to check past feedback or search_web for best practices.",
        tools=AgentTool(critique=True),
        callable_tools=AGENT_CALLABLE_TOOLS)

    scheduler = AIAgent(
        name="Study Scheduler", role="Time Management Expert",
        instructions="Generate 5-10 sessions between the dates. Return ONLY valid JSON array. Each: 'title','date'(YYYY-MM-DD),'time'(HH:MM),'duration'(int minutes).",
        tools=AgentTool(db_write=True, reschedule=True),
        callable_tools=AGENT_CALLABLE_TOOLS)

    note_taker = AIAgent(
        name="Content Writer", role="Subject Matter Writer",
        instructions="Write detailed starter notes in Markdown from the curriculum. No code block wrappers. Use search_web to flesh out topic definitions.",
        tools=AgentTool(db_write=True),
        callable_tools=AGENT_CALLABLE_TOOLS)

    try:
        # ── STEP 1: Curriculum Designer works and posts to bus + workspace ──
        AgentMessageBus.post("Orchestrator", "Curriculum Designer",
            "design_curriculum",
            f"Topic:{topic}\nLevel:{level}\nObjectives:{objectives}",
            session_id)

        msgs = curriculum_designer.read_messages(session_id)
        task_body = msgs[0]['body'] if msgs else f"Topic:{topic}\nLevel:{level}"

        html_plan = curriculum_designer.execute(task_body, memory_keys=['last_result'])
        html_plan = html_plan.replace("```html","").replace("```","").strip()

        # Post result to workspace and notify critic
        curriculum_designer.write_workspace(session_id, "curriculum_html", html_plan)
        curriculum_designer.send_message("Plan Critic", "review_curriculum",
            html_plan, session_id)

        # ── STEP 2: Plan Critic reviews ──
        msgs = critic.read_messages(session_id)
        curriculum_to_review = msgs[0]['body'] if msgs else html_plan

        review = critic.execute(f"Curriculum HTML:\n{curriculum_to_review}")
        critic.write_workspace(session_id, "critic_review", review)

        # If revision needed, critic messages the designer back
        if "REVISE" in review.upper():
            critic.send_message("Curriculum Designer", "revise_curriculum",
                f"Feedback: {review}\nOriginal task: Topic:{topic}\nLevel:{level}\nObjectives:{objectives}",
                session_id)
            # Designer reads revision request
            revision_msgs = curriculum_designer.read_messages(session_id)
            if revision_msgs:
                html_plan = curriculum_designer.execute(
                    revision_msgs[0]['body'], memory_keys=['last_result'])
                html_plan = html_plan.replace("```html","").replace("```","").strip()
                curriculum_designer.write_workspace(session_id, "curriculum_html", html_plan)

        # Designer notifies scheduler and note_taker
        curriculum_designer.send_message("Study Scheduler", "schedule_sessions",
            f"Topic:{topic}\nDates:{date_context}\nHours/day:{hours}\nCurriculum:\n{html_plan}",
            session_id)
        curriculum_designer.send_message("Content Writer", "write_notes",
            f"Topic:{topic}\nLevel:{level}\nCurriculum:\n{html_plan}",
            session_id)

        # ── STEP 3: Scheduler reads its message and acts ──
        sched_msgs = scheduler.read_messages(session_id)
        sched_task = sched_msgs[0]['body'] if sched_msgs else \
            f"Topic:{topic}\nDates:{date_context}\nHours/day:{hours}\nCurriculum:\n{html_plan}"

        sched_raw = scheduler.execute(sched_task, memory_keys=['last_result'])
        sched_raw = sched_raw.replace("```json","").replace("```","").strip()
        try:
            sessions = json.loads(sched_raw)
        except json.JSONDecodeError:
            sessions = [{"title":"Study Session","date":today,"time":"10:00","duration":60}]

        scheduler.write_workspace(session_id, "sessions_json", json.dumps(sessions))
        # Scheduler reports back to orchestrator
        scheduler.send_message("Orchestrator", "schedule_ready",
            f"{len(sessions)} sessions scheduled.", session_id)

        # ── STEP 4: Note Taker reads its message and acts ──
        note_msgs = note_taker.read_messages(session_id)
        note_task = note_msgs[0]['body'] if note_msgs else \
            f"Topic:{topic}\nLevel:{level}\nCurriculum:\n{html_plan}"

        notes_body = note_taker.execute(note_task, memory_keys=['last_result'])
        note_taker.write_workspace(session_id, "starter_notes", notes_body)
        note_taker.send_message("Orchestrator", "notes_ready",
            f"Notes written for {topic}.", session_id)

        # ── STEP 5: Orchestrator reads all completion reports and persists ──
        final_reports = AgentMessageBus.consume("Orchestrator", session_id)
        report_summary = " | ".join(m['body'] for m in final_reports)

        conn = get_db_connection()
        color = '#' + ''.join([random.choice('0123456789ABCDEF') for _ in range(6)])
        cur = conn.execute('INSERT INTO subjects (name,color) VALUES (?,?)', (topic, color))
        new_subject_id = cur.lastrowid
        for s in sessions:
            conn.execute('INSERT INTO sessions (title,date,time,duration) VALUES (?,?,?,?)',
                         (s.get('title'), s.get('date'), s.get('time'), s.get('duration')))
        conn.execute('INSERT INTO notes (title,body) VALUES (?,?)',
                     (f"Starter Notes: {topic}", notes_body))
        conn.execute('INSERT INTO notifications (message,type) VALUES (?,?)',
                     (f" [Session:{session_id}] {report_summary}", "success"))

        # ── Parse phases and save to study_phases table ──
        phases = _parse_phases_from_html(html_plan)
        try:
            start_dt = datetime.strptime(effective_start, '%Y-%m-%d')
            end_dt   = datetime.strptime(goal_date, '%Y-%m-%d') if goal_date and goal_date != 'Unknown' else start_dt + timedelta(days=21)
        except Exception:
            start_dt = datetime.now()
            end_dt   = start_dt + timedelta(days=21)
        total_days = max((end_dt - start_dt).days, len(phases))
        phase_days = total_days // len(phases)
        for i, ph in enumerate(phases):
            p_start = (start_dt + timedelta(days=i * phase_days)).strftime('%Y-%m-%d')
            p_end   = (start_dt + timedelta(days=(i + 1) * phase_days) if i < len(phases) - 1 else end_dt).strftime('%Y-%m-%d')
            conn.execute(
                '''INSERT OR REPLACE INTO study_phases
                   (subject_name, subject_id, phase_number, phase_name, start_date, end_date, is_unlocked, content_generated)
                   VALUES (?,?,?,?,?,?,?,?)''',
                (topic, new_subject_id, ph['number'], ph['name'], p_start, p_end, 1 if i == 0 else 0, 0)
            )
        conn.commit()
        conn.close()

        # ── Generate Phase 1 content in background ──
        _profile_id = request.headers.get('X-Profile-ID', '1')
        _level      = level
        _topic      = topic
        def _bg_phase1():
            with app.app_context():
                from flask import g
                g.profile_id = _profile_id
                generate_phase_content_for_subject(_topic, 1, _level, _profile_id)
        threading.Thread(target=_bg_phase1, daemon=True).start()

        return jsonify({
            "plan": html_plan,
            "critic_review": review,
            "session_id": session_id,
            "phases": phases,
            "bus_messages": AgentMessageBus.peek_all(session_id)
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Notes ──
@app.route('/api/notes', methods=['GET','POST'])
def handle_notes():
    conn = get_db_connection()
    if request.method == 'POST':
        data = request.json
        cur = conn.execute('INSERT INTO notes (title,body) VALUES (?,?)',
                           (data['title'], data['body']))
        conn.commit()
        new_id = cur.lastrowid
        conn.close()
        return jsonify({"id":new_id,"title":data['title'],"body":data['body']})
    notes = conn.execute('SELECT * FROM notes ORDER BY created_at DESC').fetchall()
    conn.close()
    return jsonify([dict(n) for n in notes])


@app.route('/api/notes/<int:note_id>', methods=['PUT','DELETE'])
def update_delete_note(note_id):
    conn = get_db_connection()
    if request.method == 'PUT':
        data = request.json
        conn.execute('UPDATE notes SET title=?,body=? WHERE id=?',
                     (data['title'], data['body'], note_id))
        conn.commit()
        conn.close()
        return jsonify({"success":True})
    conn.execute('DELETE FROM notes WHERE id=?', (note_id,))
    conn.commit()
    conn.close()
    return jsonify({"success":True})


# ── Subjects ──
@app.route('/api/subjects', methods=['GET','POST'])
def handle_subjects():
    conn = get_db_connection()
    if request.method == 'POST':
        data = request.json
        cur = conn.execute('INSERT INTO subjects (name,color) VALUES (?,?)',
                           (data['name'], data.get('color','#7c3aed')))
        conn.commit()
        new_id = cur.lastrowid
        conn.close()
        return jsonify({"id":new_id,"name":data['name'],"color":data.get('color','#7c3aed'),"status":"active"})
    subjects = conn.execute('SELECT * FROM subjects ORDER BY id DESC').fetchall()
    conn.close()
    return jsonify([dict(s) for s in subjects])


@app.route('/api/subjects/<int:subject_id>', methods=['DELETE'])
def delete_subject(subject_id):
    conn = get_db_connection()
    conn.execute('DELETE FROM subjects WHERE id=?', (subject_id,))
    conn.commit()
    conn.close()
    return jsonify({"success":True})


@app.route('/api/subjects/<int:subject_id>/toggle', methods=['PUT'])
def toggle_subject(subject_id):
    conn = get_db_connection()
    data = request.json
    conn.execute('UPDATE subjects SET status=? WHERE id=?', (data['status'], subject_id))
    conn.commit()
    conn.close()
    return jsonify({"success":True})


# ── Study Phases ──

@app.route('/api/study_phases/<path:subject_name>', methods=['GET'])
def get_study_phases(subject_name):
    conn = get_db_connection()
    rows = conn.execute(
        'SELECT id,subject_name,subject_id,phase_number,phase_name,start_date,end_date,'
        'is_unlocked,content_generated,created_at FROM study_phases '
        'WHERE subject_name=? ORDER BY phase_number', (subject_name,)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/study_phases/<path:subject_name>/<int:phase_number>/content', methods=['GET'])
def get_phase_content(subject_name, phase_number):
    conn = get_db_connection()
    phase = conn.execute(
        'SELECT * FROM study_phases WHERE subject_name=? AND phase_number=?',
        (subject_name, phase_number)
    ).fetchone()
    conn.close()
    if not phase:
        return jsonify({'error': 'Phase not found'}), 404
    if not phase['is_unlocked']:
        return jsonify({'error': 'Phase not yet unlocked', 'locked': True,
                        'unlock_date': phase['start_date']}), 403
    if phase['content_generated'] and phase['content_data']:
        try:
            c = json.loads(phase['content_data'])
            c.update({'phase_name': phase['phase_name'], 'phase_number': phase_number,
                      'start_date': phase['start_date'], 'end_date': phase['end_date']})
            return jsonify(c)
        except Exception:
            pass
    level = request.args.get('level', 'detailed')
    data = generate_phase_content_for_subject(subject_name, phase_number, level)
    if data:
        data.update({'phase_name': phase['phase_name'], 'phase_number': phase_number,
                     'start_date': phase['start_date'], 'end_date': phase['end_date']})
        return jsonify(data)
    return jsonify({'error': 'Content generation failed'}), 500


@app.route('/api/study_phases/<path:subject_name>/unlock_next', methods=['POST'])
def unlock_next_phase(subject_name):
    conn = get_db_connection()
    row = conn.execute(
        'SELECT MAX(phase_number) as mp FROM study_phases WHERE subject_name=? AND is_unlocked=1',
        (subject_name,)
    ).fetchone()
    current_max = row['mp'] if row and row['mp'] else 0
    next_num = current_max + 1
    next_phase = conn.execute(
        'SELECT * FROM study_phases WHERE subject_name=? AND phase_number=?',
        (subject_name, next_num)
    ).fetchone()
    if not next_phase:
        conn.close()
        return jsonify({'error': 'No more phases to unlock'}), 404
    conn.execute('UPDATE study_phases SET is_unlocked=1 WHERE subject_name=? AND phase_number=?',
                 (subject_name, next_num))
    conn.commit()
    conn.close()
    _add_notification(f"\U0001f389 Phase {next_num} unlocked for '{subject_name}'! Generating content...", 'success')
    _pid = request.headers.get('X-Profile-ID', '1')
    _sn  = subject_name
    def _bg():
        with app.app_context():
            from flask import g
            g.profile_id = _pid
            generate_phase_content_for_subject(_sn, next_num)
    threading.Thread(target=_bg, daemon=True).start()
    return jsonify({'success': True, 'unlocked_phase': next_num,
                    'phase_name': next_phase['phase_name']})


@app.route('/api/study_phases/<path:subject_name>/<int:phase_number>/regenerate', methods=['POST'])
def regenerate_phase_content(subject_name, phase_number):
    level = (request.json or {}).get('level', 'detailed')
    _pid = request.headers.get('X-Profile-ID', '1')
    _sn, _pn = subject_name, phase_number
    def _bg():
        with app.app_context():
            from flask import g
            g.profile_id = _pid
            generate_phase_content_for_subject(_sn, _pn, level)
    threading.Thread(target=_bg, daemon=True).start()
    return jsonify({'success': True, 'message': f'Regenerating Phase {phase_number}...'})


# ── Sessions ──
@app.route('/api/sessions', methods=['GET','POST'])
def handle_sessions():
    conn = get_db_connection()
    if request.method == 'POST':
        data = request.json
        cur = conn.execute('INSERT INTO sessions (title,date,time,duration) VALUES (?,?,?,?)',
                           (data['title'], data['date'], data['time'], data.get('duration',60)))
        conn.commit()
        new_id = cur.lastrowid
        conn.close()
        return jsonify({"id":new_id,"title":data['title'],"date":data['date'],
                        "time":data['time'],"duration":data.get('duration',60),"completed":0})
    sessions = conn.execute('SELECT * FROM sessions ORDER BY date ASC, time ASC').fetchall()
    conn.close()
    return jsonify([dict(s) for s in sessions])


@app.route('/api/sessions/<int:session_id>', methods=['DELETE'])
def delete_session(session_id):
    conn = get_db_connection()
    conn.execute('DELETE FROM sessions WHERE id=?', (session_id,))
    conn.commit()
    conn.close()
    return jsonify({"success":True})


# ── Notifications ──
@app.route('/api/notifications', methods=['GET','POST'])
def handle_notifications():
    conn = get_db_connection()
    if request.method == 'POST':
        data = request.json
        cur = conn.execute('INSERT INTO notifications (message,type) VALUES (?,?)',
                           (data['message'], data.get('type','info')))
        conn.commit()
        new_id = cur.lastrowid
        conn.close()
        return jsonify({"id":new_id,"success":True})
    notifs = conn.execute(
        'SELECT * FROM notifications WHERE is_read=0 ORDER BY created_at DESC LIMIT 10').fetchall()
    conn.close()
    return jsonify([dict(n) for n in notifs])


@app.route('/api/notifications/read', methods=['POST'])
def mark_read():
    conn = get_db_connection()
    conn.execute('UPDATE notifications SET is_read=1 WHERE is_read=0')
    conn.commit()
    conn.close()
    return jsonify({"success":True})


# ── Profiles ──
@app.route('/api/profiles', methods=['GET','POST'])
def handle_profiles():
    conn = get_master_db_connection()
    if request.method == 'POST':
        data = request.json
        cur = conn.execute(
            'INSERT INTO profile (name,email,institution,bio,level,goal,avatar_color) VALUES (?,?,?,?,?,?,?)',
            (data.get('name','New Student'), data.get('email',''), data.get('institution',''),
             data.get('bio',''), data.get('level','Beginner'), data.get('goal','Learn and grow'),
             data.get('avatar_color','#7c3aed')))
        conn.commit()
        new_id = cur.lastrowid
        conn.close()
        
        # Initialize the new user db
        init_user_db(new_id)
        
        return jsonify({"id":new_id,"success":True})
    profs = conn.execute('SELECT * FROM profile').fetchall()
    conn.close()
    return jsonify([dict(p) for p in profs])


@app.route('/api/profiles/<int:prof_id>', methods=['GET','PUT', 'DELETE'])
def specific_profile(prof_id):
    conn = get_master_db_connection()
    if request.method == 'DELETE':
        conn.execute('DELETE FROM profile WHERE id=?', (prof_id,))
        conn.commit()
        conn.close()
        # Optionally, delete the database file
        db_file = 'database.db' if prof_id == 1 else f'database_{prof_id}.db'
        if os.path.exists(db_file):
            try:
                os.remove(db_file)
            except Exception:
                pass
        return jsonify({"success":True})
    elif request.method == 'PUT':
        data = request.json
        conn.execute(
            'UPDATE profile SET name=?,email=?,institution=?,bio=?,level=?,goal=? WHERE id=?',
            (data.get('name'), data.get('email'), data.get('institution'),
             data.get('bio'), data.get('level'), data.get('goal'), prof_id))
        conn.commit()
        conn.close()
        return jsonify({"success":True})
    prof = conn.execute('SELECT * FROM profile WHERE id=?', (prof_id,)).fetchone()
    conn.close()
    return jsonify(dict(prof)) if prof else (jsonify({"error":"Not found"}), 404)


# ── AI Extras ──
@app.route('/api/ai_insights')
def ai_insights():
    if not api_key:
        return jsonify({"insight":"Configure your Groq API key to receive insights."})
    coach = AIAgent(
        name="Study Coach", role="Motivational Mentor",
        instructions="Give a short, engaging 1-2 sentence study tip for today. Keep it fresh.")
    try:
        insight = coach.execute("Generate a motivational insight.", log_reasoning=False)
        return jsonify({"insight": insight})
    except Exception:
        return jsonify({"insight":"Stay focused and keep up the great work!"})


@app.route('/api/generate_notes', methods=['POST'])
def auto_generate_notes():
    if not api_key:
        return jsonify({"error":"API key not configured"}), 500
    data = request.json
    topic = data.get('topic','General Studies')
    expert = AIAgent(
        name="Note Expert", role="Expert Tutor",
        instructions="Create comprehensive study notes in Markdown. No code block wrappers.")
    try:
        notes = expert.execute(f"Topic: '{topic}'")
        return jsonify({"notes": notes})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/ai_tutor', methods=['POST'])
def ai_tutor():
    if not api_key:
        return jsonify({"error":"API key not configured"}), 500
    data = request.json
    question = data.get('question', '')
    context = data.get('context', 'General Studies')

    researcher = AIAgent(
        name="Research Analyst", role="Deep Knowledge Extractor",
        instructions="Extract core facts, key definitions, and examples. Return a bulleted summary.")

    tutor = AIAgent(
        name="Pedagogical Expert", role="Friendly AI Tutor",
        instructions=(
            "Formulate a helpful, encouraging explanation using the research provided. "
            "If you have conversation history in memory, maintain continuity and refer back "
            "to earlier topics when relevant."
        ))

    try:
        # Load conversation history from tutor's memory
        history_raw = tutor.recall_memory('conversation_history') or '[]'
        try:
            history = json.loads(history_raw)
        except Exception:
            history = []

        # Build history context string (last 6 exchanges to avoid token overflow)
        history_context = ""
        if history:
            recent = history[-6:]
            history_context = "\n\n[Conversation History]:\n" + "\n".join(
                f"  Student: {h['q']}\n  You: {h['a'][:200]}" for h in recent
            )

        # Phase 1: Research
        research = researcher.execute(
            f"Question:'{question}'\nContext:'{context}'{history_context}")

        # Phase 2: Tutor answers with full history awareness
        answer = tutor.execute(
            f"Question:'{question}'\nContext:'{context}'"
            f"{history_context}\nResearch:\n{research}",
            memory_keys=['summary']
        )

        # Save this exchange to conversation history
        history.append({'q': question, 'a': answer[:400]})
        if len(history) > 20:  # cap at 20 exchanges
            history = history[-20:]
        tutor.save_memory('conversation_history', json.dumps(history))
        tutor.save_memory('summary', f"Last topic: {question[:100]}")

        return jsonify({"answer": answer, "history_length": len(history)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500



# ── Content Generation API ──
def _build_free_resource_links(subject: str) -> str:
    """Returns a curated HTML block of free online resources for any subject."""
    slug = urllib.parse.quote_plus(subject)
    resources = [
        {
            "category": " Always-Free Learning Platforms",
            "items": [
                ("Khan Academy", f"https://www.khanacademy.org/search?page_search_query={slug}", "Free courses, exercises, and videos on almost every academic subject."),
                ("MIT OpenCourseWare", f"https://ocw.mit.edu/search/?q={slug}", "Free MIT university lectures, notes, and assignments — used by millions worldwide."),
                ("OpenStax", "https://openstax.org/subjects", "Peer-reviewed, free open-source textbooks for college-level subjects."),
                ("Coursera (Audit Free)", f"https://www.coursera.org/search?query={slug}", "Audit thousands of university courses for free — no certificate, but full content access."),
                ("edX (Audit Free)", f"https://www.edx.org/search?q={slug}", "Free audit access to Harvard, MIT, Berkeley courses."),
                ("OpenLearn (Open University)", f"https://www.open.edu/openlearn/search-results?query={slug}", "Free courses from the UK Open University, all freely accessible."),
                ("NPTEL", f"https://nptel.ac.in/course.html", "Free IIT & IISc (India) lectures and courses on science and engineering."),
                ("Saylor Academy", "https://learn.saylor.org/", "Free college-equivalent courses with certificates upon completion."),
            ]
        },
        {
            "category": " Free Academic Papers & Research",
            "items": [
                ("arXiv", f"https://arxiv.org/search/?searchtype=all&query={slug}", "Free preprints of scientific papers in physics, math, CS, biology, and more."),
                ("Google Scholar", f"https://scholar.google.com/scholar?q={slug}", "Search millions of academic papers, theses, and books — many freely accessible."),
                ("Semantic Scholar", f"https://www.semanticscholar.org/search?q={slug}&sort=Relevance", "AI-powered free academic paper search with citation graphs."),
                ("JSTOR (Free Access)", f"https://www.jstor.org/action/doBasicSearch?Query={slug}", "Access hundreds of thousands of academic journal articles for free (limited per month)."),
                ("PubMed (Medical/Bio)", f"https://pubmed.ncbi.nlm.nih.gov/?term={slug}", "Free biomedical and life science literature database from NIH."),
                ("PLoS ONE", "https://journals.plos.org/plosone/", "Open-access peer-reviewed journal — all articles free to read."),
            ]
        },
        {
            "category": " Free Video Lectures & YouTube Resources",
            "items": [
                ("YouTube — Search", f"https://www.youtube.com/results?search_query={slug}+lecture+tutorial", "Thousands of free lectures, walkthroughs, and explanations."),
                ("CrashCourse", "https://www.youtube.com/@crashcourse", "Fast-paced, entertaining introductory videos across all major subjects."),
                ("3Blue1Brown", "https://www.youtube.com/@3blue1brown", "Visually stunning math and science explanations."),
                ("Kurzgesagt", "https://www.youtube.com/@kurzgesagt", "Beautifully animated science and philosophy explainers."),
                ("TED-Ed", "https://ed.ted.com/", "Short animated educational videos on every topic imaginable."),
                ("Numberphile / Computerphile", "https://www.youtube.com/@numberphile", "Deep dives into math and computer science concepts."),
            ]
        },
        {
            "category": " Free Interactive Tools",
            "items": [
                ("Wolfram Alpha", f"https://www.wolframalpha.com/input?i={slug}", "Computational knowledge engine — solves equations, explains concepts, generates plots."),
                ("Desmos", "https://www.desmos.com/", "Free graphing calculator and interactive math tool."),
                ("PhET Interactive Simulations", "https://phet.colorado.edu/", "Free physics, chemistry, biology, and math simulations from University of Colorado."),
                ("GeoGebra", "https://www.geogebra.org/", "Free interactive geometry, algebra, and calculus tools."),
                ("Anki", "https://apps.ankiweb.net/", "Free spaced-repetition flashcard app — best tool for memorization."),
            ]
        },
        {
            "category": " Wikipedia Deep Dives",
            "items": [
                ("Wikipedia", f"https://en.wikipedia.org/wiki/Special:Search?search={slug}", "Start here for overviews, definitions, and links to academic sources."),
                ("Wikiversity", f"https://en.wikiversity.org/w/index.php?search={slug}", "Free learning resources and study guides created by the wiki community."),
                ("Wikibooks", f"https://en.wikibooks.org/w/index.php?search={slug}", "Free open-content textbooks for many subjects."),
            ]
        },
    ]
    html_parts = ["<div class='resource-category' style='border-color:rgba(0,245,212,0.3);margin-top:24px;'>"
                  "<h4> Verified Free Online Resources</h4>"
                  "<p style='font-size:0.82em;color:var(--text-muted);margin-bottom:12px;'>Auto-curated links — click to open directly in your browser</p></div>"]
    for group in resources:
        items_html = "".join(
            f"<li><a href='{url}' target='_blank' style='color:#38bdf8;text-decoration:none;'>"
            f"<strong>{name}</strong></a> — {desc}</li>"
            for name, url, desc in group['items']
        )
        html_parts.append(
            f"<div class='resource-category'>"
            f"<h4>{group['category']}</h4>"
            f"<ul>{items_html}</ul>"
            f"</div>"
        )
    return "\n".join(html_parts)


def _fetch_wikipedia_content(topic: str, num_results: int = 5) -> list:
    """Fetch multiple Wikipedia articles for a topic and return full summaries."""
    results = []
    try:
        # Step 1: Search Wikipedia for related articles
        search_url = (
            f"https://en.wikipedia.org/w/api.php?action=query&list=search"
            f"&srsearch={urllib.parse.quote(topic)}&srlimit={num_results}"
            f"&utf8=&format=json"
        )
        req = urllib.request.Request(search_url, headers={'User-Agent': 'StudyMindAI/2.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            search_data = json.loads(resp.read().decode('utf-8'))

        pages = search_data.get('query', {}).get('search', [])

        for page in pages[:num_results]:
            title = page.get('title', '')
            try:
                # Step 2: Fetch full extract for each article
                extract_url = (
                    f"https://en.wikipedia.org/w/api.php?action=query&titles="
                    f"{urllib.parse.quote(title)}&prop=extracts&exintro=true"
                    f"&explaintext=true&exsectionformat=plain&format=json"
                )
                req2 = urllib.request.Request(extract_url, headers={'User-Agent': 'StudyMindAI/2.0'})
                with urllib.request.urlopen(req2, timeout=8) as resp2:
                    extract_data = json.loads(resp2.read().decode('utf-8'))

                pages_data = extract_data.get('query', {}).get('pages', {})
                for pid, pdata in pages_data.items():
                    extract = pdata.get('extract', '').strip()
                    if extract and len(extract) > 100:
                        results.append({
                            'title': pdata.get('title', title),
                            'extract': extract[:3000],  # Cap at 3000 chars per article
                            'url': f"https://en.wikipedia.org/wiki/{urllib.parse.quote(pdata.get('title', title).replace(' ', '_'))}"
                        })
            except Exception:
                continue
    except Exception as e:
        pass
    return results


def _fetch_wikipedia_sections(topic: str) -> list:
    """Fetch structured section data from the main Wikipedia article."""
    sections = []
    try:
        # Get full page content with sections
        url = (
            f"https://en.wikipedia.org/w/api.php?action=parse"
            f"&page={urllib.parse.quote(topic)}&prop=sections|wikitext"
            f"&format=json"
        )
        req = urllib.request.Request(url, headers={'User-Agent': 'StudyMindAI/2.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        raw_sections = data.get('parse', {}).get('sections', [])
        sections = [s.get('line', '') for s in raw_sections if s.get('toclevel', 0) == 1][:10]
    except Exception:
        pass
    return sections


def _fetch_arxiv_content(topic: str, num_results: int = 5) -> list:
    """Fetch academic papers from arXiv."""
    results = []
    try:
        url = f"http://export.arxiv.org/api/query?search_query=all:{urllib.parse.quote(topic)}&max_results={num_results}"
        req = urllib.request.Request(url, headers={'User-Agent': 'StudyMindAI/2.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            xml_data = resp.read()
        
        import xml.etree.ElementTree as ET
        root = ET.fromstring(xml_data)
        ns = {'atom': 'http://www.w3.org/2005/Atom'}
        for entry in root.findall('atom:entry', ns):
            title_el = entry.find('atom:title', ns)
            summary_el = entry.find('atom:summary', ns)
            id_el = entry.find('atom:id', ns)
            
            title = title_el.text.strip().replace('\n', ' ') if title_el is not None and title_el.text else "Untitled arXiv Paper"
            summary = summary_el.text.strip().replace('\n', ' ') if summary_el is not None and summary_el.text else "No summary available."
            paper_url = id_el.text.strip() if id_el is not None and id_el.text else "https://arxiv.org/"
            
            results.append({
                'title': title,
                'extract': summary[:3000],
                'url': paper_url,
                'source': 'arXiv'
            })
    except Exception as e:
        print(f"[arXiv Fetch] Error: {e}")
    return results


def _fetch_wikibooks_content(topic: str, num_results: int = 5) -> list:
    """Fetch educational textbooks from Wikibooks."""
    results = []
    try:
        search_url = f"https://en.wikibooks.org/w/api.php?action=query&list=search&srsearch={urllib.parse.quote(topic)}&srlimit={num_results}&utf8=&format=json"
        req = urllib.request.Request(search_url, headers={'User-Agent': 'StudyMindAI/2.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            search_data = json.loads(resp.read().decode('utf-8'))
        
        pages = search_data.get('query', {}).get('search', [])
        for page in pages[:num_results]:
            title = page.get('title', '')
            try:
                extract_url = f"https://en.wikibooks.org/w/api.php?action=query&titles={urllib.parse.quote(title)}&prop=extracts&exintro=true&explaintext=true&exsectionformat=plain&format=json"
                req2 = urllib.request.Request(extract_url, headers={'User-Agent': 'StudyMindAI/2.0'})
                with urllib.request.urlopen(req2, timeout=8) as resp2:
                    extract_data = json.loads(resp2.read().decode('utf-8'))
                
                pages_data = extract_data.get('query', {}).get('pages', {})
                for pid, pdata in pages_data.items():
                    extract = pdata.get('extract', '').strip()
                    if extract and len(extract) > 100:
                        results.append({
                            'title': pdata.get('title', title),
                            'extract': extract[:3000],
                            'url': f"https://en.wikibooks.org/wiki/{urllib.parse.quote(pdata.get('title', title).replace(' ', '_'))}",
                            'source': 'Wikibooks'
                        })
            except Exception:
                continue
    except Exception as e:
        print(f"[Wikibooks Fetch] Error: {e}")
    return results


def _fetch_wikiversity_content(topic: str, num_results: int = 5) -> list:
    """Fetch course materials and learning resources from Wikiversity."""
    results = []
    try:
        search_url = f"https://en.wikiversity.org/w/api.php?action=query&list=search&srsearch={urllib.parse.quote(topic)}&srlimit={num_results}&utf8=&format=json"
        req = urllib.request.Request(search_url, headers={'User-Agent': 'StudyMindAI/2.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            search_data = json.loads(resp.read().decode('utf-8'))
        
        pages = search_data.get('query', {}).get('search', [])
        for page in pages[:num_results]:
            title = page.get('title', '')
            try:
                extract_url = f"https://en.wikiversity.org/w/api.php?action=query&titles={urllib.parse.quote(title)}&prop=extracts&exintro=true&explaintext=true&exsectionformat=plain&format=json"
                req2 = urllib.request.Request(extract_url, headers={'User-Agent': 'StudyMindAI/2.0'})
                with urllib.request.urlopen(req2, timeout=8) as resp2:
                    extract_data = json.loads(resp2.read().decode('utf-8'))
                
                pages_data = extract_data.get('query', {}).get('pages', {})
                for pid, pdata in pages_data.items():
                    extract = pdata.get('extract', '').strip()
                    if extract and len(extract) > 100:
                        results.append({
                            'title': pdata.get('title', title),
                            'extract': extract[:3000],
                            'url': f"https://en.wikiversity.org/wiki/{urllib.parse.quote(pdata.get('title', title).replace(' ', '_'))}",
                            'source': 'Wikiversity'
                        })
            except Exception:
                continue
    except Exception as e:
        print(f"[Wikiversity Fetch] Error: {e}")
    return results


def _fetch_openlibrary_content(topic: str, num_results: int = 5) -> list:
    """Fetch free public domain books and metadata from Open Library."""
    results = []
    try:
        url = f"https://openlibrary.org/search.json?q={urllib.parse.quote(topic)}&limit={num_results}"
        req = urllib.request.Request(url, headers={'User-Agent': 'StudyMindAI/2.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            
        docs = data.get('docs', [])
        for doc in docs[:num_results]:
            title = doc.get('title', 'Unknown Title')
            authors = ", ".join(doc.get('author_name', [])) if doc.get('author_name') else 'Unknown Author'
            publish_year = doc.get('first_publish_year', 'N/A')
            key = doc.get('key', '')
            url_book = f"https://openlibrary.org{key}" if key else "https://openlibrary.org/"
            
            extract = f"A book titled '{title}' written by {authors}, first published in {publish_year}."
            if doc.get('subject'):
                subjects = ", ".join(doc.get('subject')[:5])
                extract += f" Subjects covered: {subjects}."
                
            results.append({
                'title': title,
                'extract': extract,
                'url': url_book,
                'source': 'Open Library'
            })
    except Exception as e:
        print(f"[Open Library Fetch] Error: {e}")
    return results


@app.route('/api/content/generate', methods=['POST'])
def generate_content():
    """
    Full content generation endpoint.
    Fetches Wikipedia + free online data, enriches with Groq AI,
    returns a deeply structured content object with 3 individual detailed phases.
    """
    if not api_key:
        return jsonify({"error": "Groq API key not configured"}), 500

    data = request.json or {}
    subject = data.get('subject', 'General Studies')
    level = data.get('level', 'detailed')
    use_wikipedia = data.get('use_wikipedia', True)
    use_arxiv = data.get('use_arxiv', True)
    use_wikibooks = data.get('use_wikibooks', True)
    use_wikiversity = data.get('use_wikiversity', True)
    use_openlibrary = data.get('use_openlibrary', True)
    use_examples = data.get('use_examples', True)
    use_quiz = data.get('use_quiz', True)

    try:
        # ── STEP 1: Pull external data (Wikipedia, arXiv, Wikibooks, Wikiversity, Open Library) ──
        wiki_articles = []
        wiki_sections = []
        arxiv_articles = []
        wikibooks_articles = []
        wikiversity_articles = []
        openlibrary_articles = []
        
        external_raw_text_parts = []
        
        if use_wikipedia:
            wiki_articles = _fetch_wikipedia_content(subject, num_results=6)
            wiki_sections = _fetch_wikipedia_sections(subject)
            if wiki_articles:
                external_raw_text_parts.append(
                    "Wikipedia Sources:\n" + "\n\n".join(f"=== {a['title']} ===\n{a['extract']}" for a in wiki_articles)
                )

        if use_arxiv:
            arxiv_articles = _fetch_arxiv_content(subject, num_results=5)
            if arxiv_articles:
                external_raw_text_parts.append(
                    "arXiv Academic Sources:\n" + "\n\n".join(f"=== {a['title']} ===\n{a['extract']}" for a in arxiv_articles)
                )

        if use_wikibooks:
            wikibooks_articles = _fetch_wikibooks_content(subject, num_results=5)
            if wikibooks_articles:
                external_raw_text_parts.append(
                    "Wikibooks Sources:\n" + "\n\n".join(f"=== {a['title']} ===\n{a['extract']}" for a in wikibooks_articles)
                )

        if use_wikiversity:
            wikiversity_articles = _fetch_wikiversity_content(subject, num_results=5)
            if wikiversity_articles:
                external_raw_text_parts.append(
                    "Wikiversity Sources:\n" + "\n\n".join(f"=== {a['title']} ===\n{a['extract']}" for a in wikiversity_articles)
                )

        if use_openlibrary:
            openlibrary_articles = _fetch_openlibrary_content(subject, num_results=5)
            if openlibrary_articles:
                external_raw_text_parts.append(
                    "Open Library Book Sources:\n" + "\n\n".join(f"=== {a['title']} ===\n{a['extract']}" for a in openlibrary_articles)
                )

        wiki_raw_text = "\n\n".join(external_raw_text_parts)[:12000]

        # Collect all sources in a unified list
        all_source_articles = []
        for a in wiki_articles:
            all_source_articles.append({"title": a["title"], "url": a["url"], "snippet": a["extract"][:300] + "...", "source": "Wikipedia"})
        for a in arxiv_articles:
            all_source_articles.append({"title": a["title"], "url": a["url"], "snippet": a["extract"][:300] + "...", "source": "arXiv"})
        for a in wikibooks_articles:
            all_source_articles.append({"title": a["title"], "url": a["url"], "snippet": a["extract"][:300] + "...", "source": "Wikibooks"})
        for a in wikiversity_articles:
            all_source_articles.append({"title": a["title"], "url": a["url"], "snippet": a["extract"][:300] + "...", "source": "Wikiversity"})
        for a in openlibrary_articles:
            all_source_articles.append({"title": a["title"], "url": a["url"], "snippet": a["extract"][:300] + "...", "source": "Open Library"})

        # Build HTML for display in the Sources tab
        sources_html_list = []
        for a in all_source_articles:
            source_badge = f"<span class='source-badge source-{a['source'].lower().replace(' ', '-')}' style='padding:2px 8px;border-radius:4px;font-size:0.75em;font-weight:600;margin-left:8px;'>{a['source']}</span>"
            sources_html_list.append(
                f"<div class='wiki-article-block' style='margin-bottom: 16px; border-left: 4px solid var(--primary);'>"
                f"<div class='wiki-article-title' style='display:flex;align-items:center;justify-content:space-between;'>"
                f" <span>{a['title']}</span> {source_badge}"
                f"</div>"
                f"<div class='wiki-article-body' style='margin-top:8px;'>{a['snippet']}</div>"
                f"<a href='{a['url']}' target='_blank' class='wiki-read-more' style='display:inline-block;margin-top:8px;'>Read source material →</a>"
                f"</div>"
            )
        sources_full_html = "\n".join(sources_html_list) if sources_html_list else "<div class='empty-state small'><p>No raw reference data found. Select some knowledge sources and try again.</p></div>"

        # ── STEP 2: Build curated free online resources list ──
        # This is a curated dict of free platforms mapped to URLs
        free_resource_links = _build_free_resource_links(subject)

        # ── STEP 3: Generate THREE phases INDIVIDUALLY for max detail ──
        phase_colors = [
            ("Phase 1: Foundation & Core Concepts", "#7c3aed", ""),
            ("Phase 2: Deep Understanding & Application", "#0891b2", ""),
            ("Phase 3: Mastery, Practice & Exam Readiness", "#059669", ""),
        ]

        phases_html_parts = []
        for idx, (phase_name, color, emoji) in enumerate(phase_colors):
            phase_agent = AIAgent(
                name=f"Phase{idx+1} Architect",
                role="Expert Educational Curriculum Designer",
                instructions=(
                    f"You are generating ONLY '{phase_name}' for '{subject}' at {level} level. "
                    f"This is phase {idx+1} of 3. Generate a COMPREHENSIVE, DEEPLY DETAILED phase block.\n\n"
                    "REQUIRED structure inside <div class='phase-block'>:\n"
                    "<div class='phase-header'>\n"
                    "  <div class='phase-badge'>Phase {n}</div>\n"
                    "  <h3>{Phase Title}</h3>\n"
                    "  <p class='phase-objective'> Objective: {clear learning objective}</p>\n"
                    "  <div class='phase-meta'>\n"
                    "    <span class='phase-duration'> Duration: {e.g. 2-3 weeks}</span>\n"
                    "    <span class='phase-difficulty'> Difficulty: {Beginner/Intermediate/Advanced}</span>\n"
                    "    <span class='phase-hours'> Study Hours: {total hrs}</span>\n"
                    "  </div>\n"
                    "</div>\n"
                    "<div class='phase-body'>\n"
                    "  <div class='phase-section'>\n"
                    "    <h4> Topics to Cover</h4>\n"
                    "    <ul class='phase-topics'>\n"
                    "      <li><strong>Topic Name</strong> — Detailed explanation of what to study and why (2-3 sentences each). Include sub-points.</li>\n"
                    "      ... (8-12 topics minimum)\n"
                    "    </ul>\n"
                    "  </div>\n"
                    "  <div class='phase-section'>\n"
                    "    <h4> Learning Milestones</h4>\n"
                    "    <ul class='phase-milestones'>\n"
                    "      <li>By week 1: {specific milestone}</li>\n"
                    "      ... (4-5 milestones)\n"
                    "    </ul>\n"
                    "  </div>\n"
                    "  <div class='phase-section'>\n"
                    "    <h4> Recommended Study Techniques</h4>\n"
                    "    <ul class='phase-techniques'>\n"
                    "      <li><strong>Technique name</strong>: How to apply it for this phase specifically</li>\n"
                    "      ... (4-6 techniques)\n"
                    "    </ul>\n"
                    "  </div>\n"
                    "  <div class='phase-section'>\n"
                    "    <h4> Phase Completion Checklist</h4>\n"
                    "    <ul class='phase-checklist'>\n"
                    "      <li>I can explain ... in my own words</li>\n"
                    "      ... (5-7 checkpoints)\n"
                    "    </ul>\n"
                    "  </div>\n"
                    "  <div class='phase-section'>\n"
                    "    <h4> Tips for This Phase</h4>\n"
                    "    <p class='phase-tips'>{Specific advice for succeeding in this phase}</p>\n"
                    "  </div>\n"
                    "</div>\n\n"
                    "Return ONLY the complete <div class='phase-block'> HTML. Be EXTREMELY detailed and specific to the subject. No placeholders."
                )
            )
            phase_task = (
                f"Subject: {subject}\nLevel: {level}\nPhase: {idx+1} of 3 ({phase_name})\n"
                f"Wikipedia Context:\n{wiki_raw_text[:2500] if wiki_raw_text else 'Use expert knowledge.'}"
            )
            phase_html = phase_agent.execute(phase_task, log_reasoning=False)
            phase_html = phase_html.replace("```html", "").replace("```", "").strip()
            phases_html_parts.append(phase_html)

        phases_html = "\n\n".join(phases_html_parts)

        # ── STEP 4: Key Concepts ──
        concepts_agent = AIAgent(
            name="Concept Extractor",
            role="Domain Knowledge Expert",
            instructions=(
                f"Extract the 12-15 most critical concepts for '{subject}' at {level} level. "
                "For EACH concept provide ALL of these:\n"
                "- Term/Name (bold)\n"
                "- Clear definition (3-4 sentences, academically precise)\n"
                "- Why it matters (practical importance)\n"
                "- A simple real-world analogy\n"
                "- Common misconception to avoid\n"
                "Return as HTML:\n"
                "<div class='concept-card'>"
                "<h4>Term Name</h4>"
                "<p>Full definition in 3-4 sentences.</p>"
                "<p><strong>Why it matters:</strong> Practical importance...</p>"
                "<p><em>Analogy:</em> Simple analogy...</p>"
                "<p class='concept-warning'> <strong>Common mistake:</strong> misconception...</p>"
                "</div>\n"
                "Be comprehensive and academically precise. Cover fundamentals AND advanced ideas."
            )
        )
        concepts_task = (
            f"Subject: {subject}\nLevel: {level}\n"
            f"Wikipedia Data:\n{wiki_raw_text[:3000] if wiki_raw_text else 'Use expert knowledge.'}"
        )
        concepts_html = concepts_agent.execute(concepts_task, log_reasoning=False)
        concepts_html = concepts_html.replace("```html", "").replace("```", "").strip()

        # ── STEP 5: Real-World Examples ──
        examples_html = ""
        if use_examples:
            examples_agent = AIAgent(
                name="Example Curator",
                role="Applied Learning Specialist",
                instructions=(
                    f"Provide 6-8 rich real-world examples and case studies for '{subject}'. "
                    "Each MUST include ALL of:\n"
                    "- A compelling, specific title\n"
                    "- Detailed context and scenario (3-4 sentences)\n"
                    "- Exactly which concepts it demonstrates and HOW\n"
                    "- The specific outcome or result\n"
                    "- Key lesson and takeaway\n"
                    "Return as HTML:\n"
                    "<div class='example-block'>"
                    "<h4> Specific Title</h4>"
                    "<p class='example-context'>Detailed context (3-4 sentences)...</p>"
                    "<p class='example-connection'>Concepts demonstrated: ...</p>"
                    "<p class='example-outcome'>Outcome/Result: ...</p>"
                    "<p class='example-lesson'> Key lesson: ...</p>"
                    "</div>\n"
                    "Make examples span: industry applications, historical breakthroughs, current technology, scientific research, everyday life."
                )
            )
            examples_task = f"Subject: {subject}\nLevel: {level}\nContext: {wiki_raw_text[:2000]}"
            examples_html = examples_agent.execute(examples_task, log_reasoning=False)
            examples_html = examples_html.replace("```html", "").replace("```", "").strip()

        # ── STEP 6: Quiz ──
        quiz_html = ""
        if use_quiz:
            quiz_agent = AIAgent(
                name="Assessment Designer",
                role="Educational Assessment Expert",
                instructions=(
                    f"Create 12 high-quality quiz questions for '{subject}' at {level} level.\n"
                    "Distribute as:\n"
                    "- 6 multiple choice (4 options, exactly one correct, mark with data-correct='true'/'false')\n"
                    "- 3 conceptual short-answer questions\n"
                    "- 2 scenario/application questions\n"
                    "- 1 synthesis/critical-thinking question\n\n"
                    "MCQ HTML: <div class='quiz-mcq' data-q='N'>"
                    "<p class='quiz-question'>Q{N}: Full question text?</p>"
                    "<div class='quiz-options'>"
                    "<button class='quiz-opt' data-correct='false'>A) option</button>"
                    "<button class='quiz-opt' data-correct='true'>B) correct option</button>"
                    "<button class='quiz-opt' data-correct='false'>C) option</button>"
                    "<button class='quiz-opt' data-correct='false'>D) option</button>"
                    "</div>"
                    "<p class='quiz-explanation' style='display:none'> Explanation: Why the answer is correct, and why others are wrong.</p>"
                    "</div>\n\n"
                    "Open question HTML: <div class='quiz-open'>"
                    "<p class='quiz-question'>Q{N}: Full question?</p>"
                    "<p class='quiz-answer-hint'> Key points to include: point1; point2; point3...</p>"
                    "</div>"
                )
            )
            quiz_task = f"Subject: {subject}\nLevel: {level}"
            quiz_html = quiz_agent.execute(quiz_task, log_reasoning=False)
            quiz_html = quiz_html.replace("```html", "").replace("```", "").strip()

        # ── STEP 7: Resources ── (Groq-generated + curated free links)
        resources_agent = AIAgent(
            name="Resource Librarian",
            role="Academic Resource Curator",
            instructions=(
                f"Compile a MASSIVE, comprehensive resource list for '{subject}' at {level} level.\n"
                "Include ALL of these categories with REAL, SPECIFIC resource names:\n"
                "1.  Top Textbooks (5-6): Author, title, edition, why essential\n"
                "2.  Free Online Courses (5-6): Platform (Coursera/edX/MIT OCW/Khan Academy/OpenLearn), course name, what you learn\n"
                "3.  YouTube Channels & Playlists (4-5): Channel name, what they cover, who it's for\n"
                "4.  Free Research Papers & Journals (3-4): Paper/journal name, where to find it (arXiv/Google Scholar/JSTOR)\n"
                "5.  Interactive Tools & Platforms (3-4): Tool name, what it does, free/paid\n"
                "6.  Websites & Wikis (3-4): Site name, URL description, content type\n"
                "7.  Communities & Forums (2-3): Reddit/Discord/Stack Exchange communities\n"
                "8.  Study Strategy (specific to this subject): 5-7 subject-specific study tips\n"
                "Return as HTML using <div class='resource-category'><h4> Category Name</h4>"
                "<ul><li><strong>Resource Name</strong> — Detailed description with why to use it</li></ul></div>\n"
                "Be SPECIFIC with real resource names. No placeholders."
            )
        )
        resources_task = f"Subject: {subject}\nLevel: {level}"
        resources_html = resources_agent.execute(resources_task, log_reasoning=False)
        resources_html = resources_html.replace("```html", "").replace("```", "").strip()

        # Append curated static free resource links
        resources_html += free_resource_links

        # ── STEP 8: Introduction ──
        intro_agent = AIAgent(
            name="Subject Introducer",
            role="Expert Educator & Science Communicator",
            instructions=(
                "Write a compelling, rich 4-5 sentence introduction to the subject. "
                "Cover: what it is, its history/origin briefly, why it matters today, "
                "career/real-world applications, and what the student will gain from mastering it. "
                "Be enthusiastic and motivating. Return plain text only — no HTML tags."
            )
        )
        intro_text = intro_agent.execute(
            f"Subject: {subject}\nLevel: {level}\nContext: {wiki_raw_text[:800]}",
            log_reasoning=False
        )

        return jsonify({
            "subject": subject,
            "level": level,
            "intro": intro_text,
            "phases_html": phases_html,
            "concepts_html": concepts_html,
            "examples_html": examples_html,
            "quiz_html": quiz_html,
            "resources_html": resources_html,
            "wikipedia_articles": all_source_articles,
            "wikipedia_sections": wiki_sections,
            "wiki_full_html": sources_full_html
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/quiz/generate', methods=['POST'])
def generate_custom_quiz():
    """Generates a dynamic customizable quiz on demand."""
    if not api_key:
        return jsonify({"error": "Groq API key not configured"}), 500

    data = request.json or {}
    subject = data.get('subject', 'General Studies')
    level = data.get('level', 'detailed')
    try:
        num_questions = int(data.get('num_questions', 10))
    except ValueError:
        num_questions = 10
        
    question_style = data.get('question_style', 'mixed') # mixed, mcq, scenario, short_answer

    # Cap number of questions to keep API response quick
    num_questions = min(max(num_questions, 3), 20)

    import math
    if question_style == 'mcq':
        mcq_count = num_questions
        open_count = 0
        scenario_count = 0
    elif question_style == 'scenario':
        mcq_count = 0
        open_count = 0
        scenario_count = num_questions
    elif question_style == 'short_answer':
        mcq_count = 0
        open_count = num_questions
        scenario_count = 0
    else: # mixed
        mcq_count = math.ceil(num_questions * 0.6)
        scenario_count = math.floor(num_questions * 0.2)
        open_count = num_questions - mcq_count - scenario_count

    try:
        # Build a strict prompt that forces the model to number every question
        def _build_quiz_instructions(n_mcq, n_scenario, n_open, start_q=1):
            parts = []
            if n_mcq > 0:
                parts.append(
                    f"Generate exactly {n_mcq} MCQ questions numbered Q{start_q} to Q{start_q + n_mcq - 1}.\n"
                    "Each MCQ MUST use this EXACT HTML structure:\n"
                    "<div class='quiz-mcq' data-q='N'>\n"
                    "  <p class='quiz-question'>Q{N}: Your question here?</p>\n"
                    "  <div class='quiz-options'>\n"
                    "    <button class='quiz-opt' data-correct='false'>A) Option A</button>\n"
                    "    <button class='quiz-opt' data-correct='true'>B) Correct option</button>\n"
                    "    <button class='quiz-opt' data-correct='false'>C) Option C</button>\n"
                    "    <button class='quiz-opt' data-correct='false'>D) Option D</button>\n"
                    "  </div>\n"
                    "  <p class='quiz-explanation' style='display:none'>✅ Explanation here.</p>\n"
                    "</div>"
                )
            sc_start = start_q + n_mcq
            if n_scenario > 0:
                parts.append(
                    f"Generate exactly {n_scenario} scenario/applied questions numbered Q{sc_start} to Q{sc_start + n_scenario - 1}.\n"
                    "Each MUST use: <div class='quiz-open'><p class='quiz-question'>Q{N}: scenario question?</p>"
                    "<p class='quiz-answer-hint'>💡 Key points: ...</p></div>"
                )
            oa_start = sc_start + n_scenario
            if n_open > 0:
                parts.append(
                    f"Generate exactly {n_open} short-answer questions numbered Q{oa_start} to Q{oa_start + n_open - 1}.\n"
                    "Each MUST use: <div class='quiz-open'><p class='quiz-question'>Q{N}: question?</p>"
                    "<p class='quiz-answer-hint'>💡 Key points: ...</p></div>"
                )
            return "\n\n".join(parts)

        # For large quizzes (>= 10), split into two batches to avoid token truncation
        BATCH_THRESHOLD = 10
        if num_questions >= BATCH_THRESHOLD:
            half = num_questions // 2
            remainder = num_questions - half

            def _count_split(total, mcq_frac, sc_frac):
                import math
                mcq = math.ceil(total * mcq_frac)
                sc = math.floor(total * sc_frac)
                oa = total - mcq - sc
                return mcq, sc, oa

            if question_style == 'mcq':
                b1 = (half, 0, 0)
                b2 = (remainder, 0, 0)
            elif question_style == 'scenario':
                b1 = (0, half, 0)
                b2 = (0, remainder, 0)
            elif question_style == 'short_answer':
                b1 = (0, 0, half)
                b2 = (0, 0, remainder)
            else:
                b1 = _count_split(half, 0.6, 0.2)
                b2 = _count_split(remainder, 0.6, 0.2)

            wiki_articles = _fetch_wikipedia_content(subject, num_results=2)
            wiki_context = "\n".join(a['extract'][:500] for a in wiki_articles) if wiki_articles else ""

            def _run_batch(n_mcq, n_sc, n_oa, start_q):
                instr = (
                    f"You are an educational assessment expert. Generate quiz questions for '{subject}' at {level} level.\n"
                    f"{_build_quiz_instructions(n_mcq, n_sc, n_oa, start_q)}\n\n"
                    "CRITICAL RULES:\n"
                    "- Return ONLY HTML divs. No ```html fences, no preamble, no commentary.\n"
                    "- Every single question div must be fully closed and valid HTML.\n"
                    "- Do NOT stop early — generate ALL requested questions."
                )
                batch_agent = AIAgent(
                    name=f"QuizBatch_{start_q}",
                    role="Educational Assessment Expert",
                    instructions=instr
                )
                task_txt = f"Subject: {subject}\nContext: {wiki_context[:800]}\nGenerate all {n_mcq + n_sc + n_oa} questions now."
                raw = batch_agent.execute(task_txt, log_reasoning=False)
                return raw.replace("```html", "").replace("```", "").strip()

            batch1_html = _run_batch(*b1, 1)
            batch2_html = _run_batch(*b2, half + 1)
            quiz_html = batch1_html + "\n" + batch2_html

        else:
            # Single call for small quizzes
            instr = (
                f"You are an educational assessment expert. Generate exactly {num_questions} quiz questions for '{subject}' at {level} level.\n"
                f"{_build_quiz_instructions(mcq_count, scenario_count, open_count, 1)}\n\n"
                "CRITICAL RULES:\n"
                "- Return ONLY HTML divs. No ```html fences, no preamble, no commentary.\n"
                "- Every single question div must be fully closed and valid HTML.\n"
                "- Do NOT stop early — generate ALL requested questions."
            )
            quiz_agent = AIAgent(
                name="Assessment Designer",
                role="Educational Assessment Expert",
                instructions=instr
            )
            wiki_articles = _fetch_wikipedia_content(subject, num_results=2)
            wiki_context = "\n".join(a['extract'][:500] for a in wiki_articles) if wiki_articles else ""
            task_txt = f"Subject: {subject}\nLevel: {level}\nContext: {wiki_context[:800]}\nGenerate all {num_questions} questions now."
            quiz_html = quiz_agent.execute(task_txt, log_reasoning=False)
            quiz_html = quiz_html.replace("```html", "").replace("```", "").strip()

        return jsonify({
            "subject": subject,
            "level": level,
            "num_questions": num_questions,
            "question_style": question_style,
            "quiz_html": quiz_html
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/agent_memory', methods=['GET'])
def get_agent_memory():
    """Returns all agent memory entries for display in the Agent Hub."""
    conn = get_db_connection()
    rows = conn.execute(
        'SELECT agent_name, key, value, updated_at FROM agent_memory ORDER BY agent_name, key'
    ).fetchall()
    conn.close()
    # Group by agent name
    grouped = {}
    for row in rows:
        agent = row['agent_name']
        if agent not in grouped:
            grouped[agent] = []
        # Skip raw conversation history — too large for display
        if row['key'] == 'conversation_history':
            val = f"[{len(json.loads(row['value'] or '[]'))} exchanges stored]"
        else:
            val = row['value']
        grouped[agent].append({
            'key': row['key'], 'value': val, 'updated_at': row['updated_at']
        })
    return jsonify(grouped)


@app.route('/api/topic/expand', methods=['POST'])
def expand_topic():
    """
    Fetches deep multi-source content for a given topic heading.
    Used by the content section's click-to-expand read-more feature.
    Returns structured sections from Wikipedia, Wikibooks, arXiv and an AI summary.
    """
    data = request.json or {}
    topic = data.get('topic', '').strip()
    if not topic:
        return jsonify({'error': 'Topic is required'}), 400

    results = {'topic': topic, 'sources': []}

    # ── 1. Wikipedia: full extract + section list ──
    try:
        # Main article extract (intro + full body)
        extract_url = (
            f"https://en.wikipedia.org/w/api.php?action=query"
            f"&titles={urllib.parse.quote(topic)}"
            f"&prop=extracts&explaintext=true&exsectionformat=plain&format=json"
        )
        req = urllib.request.Request(extract_url, headers={'User-Agent': 'StudyMindAI/2.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            ex_data = json.loads(resp.read().decode('utf-8'))
        pages = ex_data.get('query', {}).get('pages', {})
        for pid, pdata in pages.items():
            if pid == '-1':
                break
            extract = pdata.get('extract', '').strip()
            if extract:
                # Split into paragraphs and cap at 5000 chars
                paragraphs = [p.strip() for p in extract.split('\n\n') if p.strip()]
                full_text = '\n\n'.join(paragraphs)[:5000]
                wiki_url = f"https://en.wikipedia.org/wiki/{urllib.parse.quote(pdata.get('title', topic).replace(' ', '_'))}"
                results['sources'].append({
                    'source': 'Wikipedia',
                    'color': '#0891b2',
                    'icon': '📖',
                    'title': pdata.get('title', topic),
                    'content': full_text,
                    'url': wiki_url
                })
    except Exception:
        pass

    # ── 2. Related Wikipedia articles (search) ──
    try:
        search_url = (
            f"https://en.wikipedia.org/w/api.php?action=query&list=search"
            f"&srsearch={urllib.parse.quote(topic)}&srlimit=3&utf8&format=json"
        )
        req = urllib.request.Request(search_url, headers={'User-Agent': 'StudyMindAI/2.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            s_data = json.loads(resp.read().decode('utf-8'))
        for page in s_data.get('query', {}).get('search', [])[:3]:
            rel_title = page.get('title', '')
            if rel_title.lower() == topic.lower():
                continue  # skip if same as main article
            snippet = re.sub(r'<[^>]+>', '', page.get('snippet', ''))
            rel_url = f"https://en.wikipedia.org/wiki/{urllib.parse.quote(rel_title.replace(' ', '_'))}"
            results['sources'].append({
                'source': 'Wikipedia (Related)',
                'color': '#06b6d4',
                'icon': '🔗',
                'title': rel_title,
                'content': snippet,
                'url': rel_url
            })
    except Exception:
        pass

    # ── 3. Wikibooks ──
    try:
        wb_url = (
            f"https://en.wikibooks.org/w/api.php?action=query&list=search"
            f"&srsearch={urllib.parse.quote(topic)}&srlimit=2&utf8&format=json"
        )
        req = urllib.request.Request(wb_url, headers={'User-Agent': 'StudyMindAI/2.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            wb_data = json.loads(resp.read().decode('utf-8'))
        for page in wb_data.get('query', {}).get('search', [])[:2]:
            wb_title = page.get('title', '')
            wb_snippet = re.sub(r'<[^>]+>', '', page.get('snippet', ''))
            wb_page_url = f"https://en.wikibooks.org/wiki/{urllib.parse.quote(wb_title.replace(' ', '_'))}"
            results['sources'].append({
                'source': 'Wikibooks',
                'color': '#10b981',
                'icon': '📚',
                'title': wb_title,
                'content': wb_snippet,
                'url': wb_page_url
            })
    except Exception:
        pass

    # ── 4. arXiv (academic papers) ──
    try:
        arxiv_url = f"http://export.arxiv.org/api/query?search_query=all:{urllib.parse.quote(topic)}&max_results=2"
        req = urllib.request.Request(arxiv_url, headers={'User-Agent': 'StudyMindAI/2.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            xml_data = resp.read()
        import xml.etree.ElementTree as ET
        root = ET.fromstring(xml_data)
        ns = {'atom': 'http://www.w3.org/2005/Atom'}
        for entry in root.findall('atom:entry', ns)[:2]:
            t_el = entry.find('atom:title', ns)
            s_el = entry.find('atom:summary', ns)
            id_el = entry.find('atom:id', ns)
            if t_el is not None and s_el is not None:
                ax_title = t_el.text.strip().replace('\n', ' ')
                ax_summary = s_el.text.strip().replace('\n', ' ')[:1200]
                ax_url = id_el.text.strip() if id_el is not None else 'https://arxiv.org'
                results['sources'].append({
                    'source': 'arXiv',
                    'color': '#ec4899',
                    'icon': '🔬',
                    'title': ax_title,
                    'content': ax_summary,
                    'url': ax_url
                })
    except Exception:
        pass

    # ── 5. AI Summary (Groq) — brief synthesis ──
    if api_key and results['sources']:
        try:
            combined_text = ' '.join([s['content'] for s in results['sources'][:2]])[:2000]
            ai_resp = groq_client.chat.completions.create(
                model="meta-llama/llama-4-scout-17b-16e-instruct",
                messages=[{
                    "role": "user",
                    "content": (
                        f"Based on the following reference text about '{topic}', write a concise, "
                        f"engaging 3-4 sentence study summary. Focus on the most important facts, "
                        f"historical context, and significance. Be educational and clear.\n\n"
                        f"Reference:\n{combined_text}"
                    )
                }],
                max_tokens=300,
                temperature=0.4
            )
            ai_summary = ai_resp.choices[0].message.content.strip()
            # Prepend the AI summary as the first source
            results['sources'].insert(0, {
                'source': 'AI Summary',
                'color': '#a78bfa',
                'icon': '✨',
                'title': f'AI Study Summary — {topic}',
                'content': ai_summary,
                'url': None
            })
        except Exception:
            pass

    return jsonify(results)


if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
