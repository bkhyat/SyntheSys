#!/usr/bin/env bash
# ==============================================================================
# SyntheSys Server Boot & Run Script
# Boots the FastAPI backend and Vite frontend development server.
# ==============================================================================

set -euo pipefail

# Determine project root directory
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

# ANSI Colors
BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

MODE="fullstack"
BACKEND_PORT=3001
FRONTEND_PORT=5173
BACKEND_PID=""
FRONTEND_PID=""

show_help() {
  echo -e "${BOLD}SyntheSys Server Runner${NC}"
  echo ""
  echo "Usage: ./start.sh [options]"
  echo ""
  echo "Options:"
  echo "  -h, --help           Show this help message and exit"
  echo "  -b, --backend-only   Run only the FastAPI backend server (port ${BACKEND_PORT})"
  echo "  -f, --frontend-only  Run only the Vite frontend dev server (port ${FRONTEND_PORT})"
  echo "  -i, --install        Install or update all dependencies (Python and Node.js)"
  echo "  -p, --port <port>    Custom backend port (default: 3001)"
  echo ""
  echo "Examples:"
  echo "  ./start.sh             # Boot fullstack application"
  echo "  ./start.sh -b          # Run only FastAPI backend"
  echo "  ./start.sh -f          # Run only Vite frontend"
  echo "  ./start.sh -i          # Install/sync dependencies"
}

# Parse command-line flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      show_help
      exit 0
      ;;
    -b|--backend-only)
      MODE="backend"
      shift
      ;;
    -f|--frontend-only)
      MODE="frontend"
      shift
      ;;
    -i|--install)
      MODE="install"
      shift
      ;;
    -p|--port)
      if [[ -n "${2:-}" ]]; then
        BACKEND_PORT="$2"
        shift 2
      else
        error "Option -p/--port requires a port argument."
        exit 1
      fi
      ;;
    *)
      error "Unknown option: $1"
      show_help
      exit 1
      ;;
  esac
done

cleanup() {
  trap - SIGINT SIGTERM EXIT
  echo ""
  info "Shutting down server processes..."
  if [[ -n "${BACKEND_PID}" ]] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    kill -TERM "${BACKEND_PID}" 2>/dev/null || true
  fi
  if [[ -n "${FRONTEND_PID}" ]] && kill -0 "${FRONTEND_PID}" 2>/dev/null; then
    kill -TERM "${FRONTEND_PID}" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  success "All processes stopped."
}

setup_env() {
  if [[ ! -f ".env" ]]; then
    if [[ -f ".env.example" ]]; then
      cp .env.example .env
      warn "Created .env from .env.example. Set your GEMINI_API_KEY in .env for AI paper screening."
    fi
  fi
}

setup_python() {
  if [[ ! -d ".venv" ]]; then
    info "Python virtual environment (.venv) not found. Creating..."
    if command -v python3 >/dev/null 2>&1; then
      python3 -m venv .venv
    else
      error "python3 is not available in PATH. Please install Python 3.10+."
      exit 1
    fi
    success "Virtual environment created."
    info "Installing Python dependencies..."
    .venv/bin/pip install --upgrade pip
    .venv/bin/pip install -r requirements.txt
    success "Python dependencies installed."
  fi

  # Activate virtualenv
  # shellcheck source=/dev/null
  source ".venv/bin/activate"

  if ! python -c "import fastapi, uvicorn" 2>/dev/null; then
    warn "Required Python packages not installed in .venv. Installing now..."
    pip install -r requirements.txt
    success "Python packages installed."
  fi
}

setup_node() {
  if ! command -v npm >/dev/null 2>&1; then
    error "npm is not installed or not available in PATH. Please install Node.js."
    exit 1
  fi

  if [[ ! -d "node_modules" ]]; then
    info "node_modules not found. Installing Node.js dependencies..."
    npm install
    success "Node dependencies installed."
  fi
}

check_port() {
  local port="$1"
  local name="$2"
  if lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    local pid
    pid=$(lsof -Pi :"$port" -sTCP:LISTEN -t | head -n 1)
    warn "Port $port is currently in use by PID $pid ($name)."
    warn "If an existing instance is running, you can stop it with: kill $pid"
  fi
}

info "Initializing SyntheSys environment..."
setup_env
setup_python
setup_node

if [[ "$MODE" == "install" ]]; then
  info "Updating Python dependencies..."
  pip install --upgrade pip
  pip install -r requirements.txt
  info "Updating Node dependencies..."
  npm install
  success "All dependencies are up to date."
  exit 0
fi

echo -e "${CYAN}${BOLD}"
echo "   ___             _   _          ___            "
echo "  / __|_  _ _ _  _| |_| |_  ___  / __|_  _ ___   "
echo "  \__ \ || | ' \|  _| ' \/ -_) \__ \ || (_-< _ \ "
echo "  |___/\_, |_||_|\__|_||_\___| |___/\_, /__/\__/ "
echo "       |__/                         |__/         "
echo -e "${NC}"

trap cleanup SIGINT SIGTERM EXIT

if [[ "$MODE" == "backend" ]]; then
  check_port "$BACKEND_PORT" "FastAPI Backend"
  echo -e "${GREEN}➜${NC} FastAPI Backend: ${BOLD}http://localhost:${BACKEND_PORT}${NC}"
  echo -e "${GREEN}➜${NC} API Docs:        ${BOLD}http://localhost:${BACKEND_PORT}/docs${NC}"
  echo ""
  python -m uvicorn backend.main:app --reload --port "$BACKEND_PORT"
elif [[ "$MODE" == "frontend" ]]; then
  check_port "$FRONTEND_PORT" "Vite Frontend"
  echo -e "${GREEN}➜${NC} Vite Frontend:   ${BOLD}http://localhost:${FRONTEND_PORT}${NC}"
  echo ""
  npx vite
else
  check_port "$BACKEND_PORT" "FastAPI Backend"
  check_port "$FRONTEND_PORT" "Vite Frontend"

  echo -e "${BOLD}Starting SyntheSys Services...${NC}"
  echo -e "  ${GREEN}➜${NC} Web App:   ${BOLD}http://localhost:${FRONTEND_PORT}${NC}"
  echo -e "  ${GREEN}➜${NC} API Docs:  ${BOLD}http://localhost:${BACKEND_PORT}/docs${NC}"
  echo -e "  ${GREEN}➜${NC} Backend:   ${BOLD}http://localhost:${BACKEND_PORT}${NC}"
  echo ""

  # Start FastAPI backend
  python -m uvicorn backend.main:app --reload --port "$BACKEND_PORT" &
  BACKEND_PID=$!

  # Start Vite frontend
  npx vite &
  FRONTEND_PID=$!

  # Wait for both background processes
  wait "$BACKEND_PID" "$FRONTEND_PID"
fi
