#!/usr/bin/env bash
# E2E smoke tests for pi-commandcode-provider
# Tests real API calls against Command Code's /alpha/generate endpoint.
#
# Usage:
#   COMMANDCODE_API_KEY=user_xxx bash tests/e2e/smoke.sh
#
# Requires: pi (coding agent) installed and this provider accessible.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS=0
FAIL=0
SKIP=0

# ─── Config ──────────────────────────────────────────────────────────────────

PROVIDER_PATH="$(cd "$(dirname "$0")/../.." && pwd)"
TIMEOUT=45

if [ -z "${COMMANDCODE_API_KEY:-}" ]; then
  echo -e "${RED}ERROR: COMMANDCODE_API_KEY not set${NC}"
  echo "Usage: COMMANDCODE_API_KEY=user_xxx bash tests/e2e/smoke.sh"
  exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Command Code Provider — E2E Smoke Tests"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ─── Helpers ─────────────────────────────────────────────────────────────────

run_test() {
  local name="$1"
  local model="$2"
  local prompt="$3"
  local expected="$4"

  echo -n "  $name ... "

  # Run pi with the model and capture output
  output=$(timeout "$TIMEOUT" pi --no-extensions \
    -e "$PROVIDER_PATH" \
    --model "commandcode/$model" \
    --no-tools \
    -p "$prompt" 2>&1) || true

  # Check if output contains expected string (case-insensitive)
  if echo "$output" | grep -qi "$expected"; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++)) || true
  else
    echo -e "${RED}FAIL${NC}"
    echo "    Expected output to contain: $expected"
    echo "    Got: $(echo "$output" | head -3)"
    ((FAIL++)) || true
  fi
}

skip_test() {
  local name="$1"
  local reason="$2"
  echo -n "  $name ... "
  echo -e "${YELLOW}SKIP${NC} ($reason)"
  ((SKIP++)) || true
}

# ─── API Auth Check ──────────────────────────────────────────────────────────

echo -e "${YELLOW}1. API Authentication${NC}"
echo -n "  Auth check ... "
whoami=$(curl -s https://api.commandcode.ai/alpha/whoami \
  -H "Authorization: Bearer $COMMANDCODE_API_KEY" 2>&1) || true

if echo "$whoami" | grep -q '"success":true'; then
  echo -e "${GREEN}PASS${NC}"
  ((PASS++)) || true
else
  echo -e "${RED}FAIL${NC}"
  echo "    API key is invalid or API is unreachable"
  echo "    Response: $whoami"
  ((FAIL++)) || true
fi

echo ""

# ─── Model Smoke Tests ──────────────────────────────────────────────────────

echo -e "${YELLOW}2. Model Smoke Tests${NC}"

# Test with the cheapest/fastest model first
run_test "DeepSeek V4 Flash (simple math)" \
  "deepseek/deepseek-v4-flash" \
  "What is 2+3? Answer with just the number." \
  "5"

run_test "DeepSeek V4 Flash (knowledge)" \
  "deepseek/deepseek-v4-flash" \
  "What is the capital of Japan? One word." \
  "tokyo"

run_test "GLM 5.1 (simple math)" \
  "zai-org/GLM-5.1" \
  "What is 7+3? Answer with just the number." \
  "10"

run_test "Kimi K2.5 (simple math)" \
  "moonshotai/Kimi-K2.5" \
  "What is 4+5? Answer with just the number." \
  "9"

run_test "Step 3.5 Flash (simple math)" \
  "stepfun/Step-3.5-Flash" \
  "What is 6+2? Answer with just the number." \
  "8"

echo ""

# ─── Premium Models (skip if on Go plan) ─────────────────────────────────────

echo -e "${YELLOW}3. Premium Models${NC}"

# These will fail with 402/403 on Go plan — that's expected, we skip gracefully
skip_test "Claude Sonnet 4.6" "Requires Pro plan"
skip_test "GPT-5.5" "Requires Pro plan"

echo ""

# ─── Error Handling ──────────────────────────────────────────────────────────

echo -e "${YELLOW}4. Error Handling${NC}"

echo -n "  Invalid API key ... "
output=$(COMMANDCODE_API_KEY="user_invalid_key_12345" \
  timeout "$TIMEOUT" pi --no-extensions \
  -e "$PROVIDER_PATH" \
  --model "commandcode/deepseek/deepseek-v4-flash" \
  --no-tools \
  -p "test" 2>&1) || true

if echo "$output" | grep -qi "error\|401\|403\|unauthorized\|invalid"; then
  echo -e "${GREEN}PASS${NC}"
  ((PASS++)) || true
else
  echo -e "${RED}FAIL${NC}"
  echo "    Expected error for invalid key"
  echo "    Got: $(echo "$output" | head -3)"
  ((FAIL++)) || true
fi

echo -n "  Invalid model ID ... "
output=$(timeout "$TIMEOUT" pi --no-extensions \
  -e "$PROVIDER_PATH" \
  --model "commandcode/nonexistent-model-xyz" \
  --no-tools \
  -p "test" 2>&1) || true

if echo "$output" | grep -qi "error"; then
  echo -e "${GREEN}PASS${NC}"
  ((PASS++)) || true
else
  echo -e "${RED}FAIL${NC}"
  echo "    Expected error for invalid model"
  echo "    Got: $(echo "$output" | head -3)"
  ((FAIL++)) || true
fi

echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${GREEN}PASS${NC}: $PASS  ${RED}FAIL${NC}: $FAIL  ${YELLOW}SKIP${NC}: $SKIP"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
