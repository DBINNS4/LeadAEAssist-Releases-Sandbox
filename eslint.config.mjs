import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import css from "@eslint/css";
import { defineConfig } from "eslint/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacyDialogAllowlistPath = path.join(__dirname, "config", "legacy-dialog-allowlist.json");
const legacyDialogAllowlist = JSON.parse(fs.readFileSync(legacyDialogAllowlistPath, "utf8"));
const legacyDialogAllowlistFiles = Object.keys(legacyDialogAllowlist.maxAllowedByFile || {}).sort();

export default defineConfig([
  {
    ignores: [
      "tools/fixtures/**",
      "node_modules",
      "venv*",
      "dist",
      "dist-obfuscated", // ← add this
      "release",
      "release/**",
      "python_embedded",
      "python_embedded/**",
      "vendor",
      "vendor/**",
      "cep",
      "cep/**",
      "resources/cep",
      "resources/cep/**",
      "tools/zxpsigncmd",
      "tools/zxpsigncmd/**",
      "build/cep_signing/**",
      "cep/extensions/**",
      "services/entitlement-service/**",
      "whisper.cpp",
      "resources/ffmpeg*",
      "resources/ffprobe*",
      "CTranslate2",
      "third_party",
      "*.min.js",
      "test/data",
      "temp",
      "**/package-lock.json"
    ]
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    plugins: {
      js
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "warn",
        {
          "vars": "all",
          "args": "after-used",
          "ignoreRestSiblings": true,
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_"
        }
      ],
      "no-empty": ["warn", { "allowEmptyCatch": true }],
      "no-useless-catch": "warn",
      "no-control-regex": "warn",
      "no-useless-escape": "warn"
      // Timecode/frame math is verified by dedicated repo checks and round-trip
      // self-tests (see `npm run verify:timecode`). A global Math.round/ceil ban
      // was flagging UI/layout/percentage/byte-estimate code and drowning out
      // real lint signal.
    }
  },
  {
    files: ["**/*.json"],
    plugins: { json },
    language: "json/json",
    extends: ["json/recommended"]
  },
  {
    files: ["**/*.jsonc"],
    plugins: { json },
    language: "json/jsonc",
    extends: ["json/recommended"]
  },
  {
    files: ["**/*.json5"],
    plugins: { json },
    language: "json/json5",
    extends: ["json/recommended"]
  },
  {
    files: ["**/*.md"],
    plugins: { markdown },
    language: "markdown/gfm",
    extends: ["markdown/recommended"]
  },
  {
    files: ["**/*.css"],
    plugins: { css },
    language: "css/css",
    extends: ["css/recommended"],
    // CSS linting is noisy in an Electron app (custom properties, vendor-prefixed props, etc).
    // Keep obvious issues visible, but don't block ship on CSS rules.
    rules: {
      "css/no-invalid-properties": "off",
      "css/no-invalid-at-rules": "off",
      "css/no-important": "off",
      "css/use-baseline": "off",
      "css/no-empty-blocks": "warn"
    }
  },

  {
    files: ["renderer.*.js", "renderer*.js"],
    languageOptions: {
      globals: {
        ipc: "readonly",
        setupStyledDropdown: "readonly",
        setDropdownValue: "readonly"
      }
    },
    rules: {
      "no-alert": "error"
    }
  },
  legacyDialogAllowlistFiles.length
    ? {
        // Temporary Phase 0 carve-out while legacy browser dialogs are migrated.
        // The audit script keeps the current inventory explicit so new raw dialogs
        // still fail lint instead of quietly spreading to more renderer files.
        files: legacyDialogAllowlistFiles,
        rules: {
          "no-alert": "off"
        }
      }
    : null,
  {
    files: ["test/**/*.js", "**/*.test.js", "jest.setup.js"],
    languageOptions: {
      globals: {
        ...globals.jest
      }
    },
    rules: {
      "no-alert": "off"
    }
  }
].filter(Boolean));
