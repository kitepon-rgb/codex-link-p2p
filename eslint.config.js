// ESLint flat config for codex-link-p2p.
//
// 主目的: CLAUDE.md の鉄則「Relay は payload を観測しない」を機械的に強制する。
// services/relay/src/ から `@codex-link/protocol/session` の import と、
// broker 概念のトークン (client.toHost / host.event / appendHostEvent 等) を
// AST レベルで禁止する。
//
// その他のスタイルルールは Phase 1 では入れない。Phase が進む過程で必要が
// 出てきたら追加する。

import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.tsbuildinfo",
      "**/*.tsbuildinfo",
      "apps/ios/**",
      "pnpm-lock.yaml",
    ],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
  // ===== Relay: payload-blind ガード =====
  //
  // Relay は signaling envelope 中継 + TURN credential 発行 + auth/registry のみ。
  // session protocol を import したり、broker 概念トークンを書いた瞬間に落とす。
  {
    files: ["services/relay/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@codex-link/protocol/session",
              message:
                "Relay must not import session protocol — payload routing is forbidden. See CLAUDE.md.",
            },
          ],
          patterns: [
            {
              group: ["@codex-link/protocol/session", "@codex-link/protocol/session/*"],
              message:
                "Relay must not import anything from the session protocol. See CLAUDE.md.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // 関数名 / 変数名: broker 経路の名前そのもの
          selector:
            "Identifier[name=/^(appendHostEvent|readHostEventReplay|sendHostEvent|routeToHost|subscribeHost)$/]",
          message:
            "Broker concept identifier forbidden in Relay. See CLAUDE.md (してはいけないこと).",
        },
        {
          // プロパティアクセス: client.toHost
          selector:
            "MemberExpression[object.name='client'][property.name='toHost']",
          message:
            "Broker concept 'client.toHost' forbidden in Relay. See CLAUDE.md.",
        },
        {
          // メッセージ type の文字列リテラル
          selector:
            "Literal[value=/^(host\\.event|host\\.subscription\\.ready|client\\.toHost)$/]",
          message:
            "Broker message type forbidden in Relay. See CLAUDE.md (してはいけないこと).",
        },
      ],
    },
  }
);
