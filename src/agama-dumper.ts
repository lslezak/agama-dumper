#! /usr/bin/env node

import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

import { program } from "commander";
import { question } from "readline-sync";

// the default OpenAPI specification
const DEFAULT_API_URL = "https://agama-project.github.io/openapi/nightly/openapi-full.json";

// define command line arguments
program
  .description("Dump the current Agama REST API data")
  .option(
    "-a, --api <dir|url>",
    "Agama OpenAPI specification: a directory with *.json files or an URL of a JSON file (downloaded files are cached for 1 hour)",
    DEFAULT_API_URL
  )
  .option("-d, --debug", "Enable debugging")
  .option("-u, --url <url>", "Agama server URL", "https://agama.local")
  .option("-p, --password <password>", "Agama login password")
  .option("-o, --output <dir>", "Output directory for the dump files", "dump");

program.parse();
const options = program.opts();

// read the password from terminal if not specified from command line
if (!options.password) {
  options.password = question(`Enter login password for Agama at ${options.url}: `, {
    // do not print the entered password in the terminal
    hideEchoBack: true,
    mask: "",
  });
}

// print a warning on stderr
function warn(msg: string) {
  process.stderr.write(msg);
  process.stderr.write("\n");
}

// helper function, login to Agama, resolves to the Agama authentication token
async function login(url: string, password: string): Promise<string> {
  const downloader = url.startsWith("https://") ? https : http;
  const loginData = JSON.stringify({ password });

  const httpOptions = {
    // ignore HTTPS errors (self-signed certificate)
    rejectUnauthorized: false,
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  };

  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    const req = downloader.request(url + "/api/auth", httpOptions, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject("Login failed");
        } else {
          try {
            const data = JSON.parse(chunks.join(""));
            if (!data.token) {
              reject("Login failed: no token in the response");
            } else {
              resolve(data.token);
            }
          } catch (e) {
            reject("Login failed: invalid response");
          }
        }
      });
    });

    req.on("error", (e) => {
      reject(e.message);
    });

    // write request body
    req.write(loginData);
    req.end();
  });
}

async function api(url: string, token: string): Promise<any> {
  const downloader = url.startsWith("https://") ? https : http;
  const httpOptions = {
    // ignore HTTPS errors (self-signed certificate)
    rejectUnauthorized: false,
    headers: {
      authorization: "Bearer " + token,
    },
  };

  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    const req = downloader.get(url, httpOptions, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode === 404) {
          // e.g. no proposal exists yet, it is a valid state
          warn(`Not found: ${url}`);
          resolve(null);
        } else if (res.statusCode !== 200) {
          if (options.debug) warn(`HTTP code ${res.statusCode}, response: ${chunks.join("")}`);
          reject("Download failed");
        } else {
          // the header might contain parameters, e.g. "application/json; charset=utf-8"
          if (res.headers["content-type"]?.startsWith("application/json")) {
            try {
              resolve(JSON.parse(chunks.join("")));
            } catch (e) {
              reject(`Invalid JSON received from ${url}`);
            }
          } else {
            warn(`Ignoring ${res.headers["content-type"]} content`);
            resolve(null);
          }
        }
      });
    });

    req.on("error", (e) => {
      reject(e.message);
    });
  });
}

// check the downloaded data
function sanityCheck(data: any) {
  const config = data["/api/config"];
  if (!config || !config.product) {
    warn(
      "WARNING: No product is selected, some settings (storage, software) depend on selected product."
    );
  }
}

// the paths returning localized data (i.e. depending on the current UI language) are marked
// in the OpenAPI data with this vendor flag
function isTranslated(pathItem: any): boolean {
  return pathItem["x-agama-translated"] === true || pathItem.get?.["x-agama-translated"] === true;
}

// Paths with parameters, it returns the list of parameter values for the given path. The values
// are read from the (already downloaded) data of the given language.
const pathParameters: Record<string, (data: any) => string[]> = {
  "/api/licenses/{id}": (data) => (data["/api/system"]?.licenses || []).map((l: any) => l.id),
};

// expand a path with parameter, resolves to the list of concrete paths
function expandPath(name: string, data: any): string[] {
  const values = pathParameters[name];
  if (!values) {
    warn(`Skipping ${name}: unknown parameter values`);
    return [];
  }
  return values(data).map((value) => name.replace(/\{[^}]+\}/, encodeURIComponent(value)));
}

// download a path and store the result in the target object
async function apiDownload(url: string, apiPath: string, token: string, target: any) {
  warn(`Downloading ${apiPath}`);
  // remove trailing slash from the path
  const requestPath = apiPath.replace(/\/$/, "");
  const res = await api(url + requestPath, token);
  target[requestPath] = res;
}

// run an installer action, see the POST /api/action in the OpenAPI specification
async function runAction(url: string, token: string, action: any) {
  const downloader = url.startsWith("https://") ? https : http;
  const httpOptions = {
    // ignore HTTPS errors (self-signed certificate)
    rejectUnauthorized: false,
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer " + token,
    },
    method: "POST",
  };

  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    const req = downloader.request(url + "/api/action", httpOptions, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          if (options.debug) warn(`HTTP code ${res.statusCode}, response: ${chunks.join("")}`);
          reject("Running the action failed");
        } else {
          resolve(null);
        }
      });
    });
    req.on("error", (e) => {
      reject(e.message);
    });

    // write request body
    req.write(JSON.stringify(action));
    req.end();
  });
}

function switchLanguage(url: string, token: string, language: string) {
  return runAction(url, token, { configureL10n: { locale: language } });
}

// download the translated paths for all supported languages, resolves to an object
// with the data for each language
async function localizedPaths(
  url: string,
  token: string,
  localized: string[],
  localizedTemplates: string[]
) {
  const apiPath = "/languages.json";
  warn(`Downloading ${apiPath}`);
  const languages = await api(url + apiPath, token);

  if (!languages) {
    warn("No languages found, skipping localized paths");
    return {};
  }

  // remember the original language to restore it at the end
  const system = await api(url + "/api/system", token);
  const originalLanguage: string | undefined = system?.l10n?.locale;
  const result: Record<string, any> = {};

  try {
    for (const language in languages) {
      const [lang, country] = language.split("-", 2);
      // the country part is optional
      const uiLanguage = (country ? lang + "_" + country.toUpperCase() : lang) + ".UTF-8";
      warn("Switching UI language to " + uiLanguage);
      await switchLanguage(url, token, uiLanguage);

      const langData: any = {};
      result[language] = langData;

      for (const localizedPath of localized) {
        await apiDownload(url, localizedPath, token, langData);
      }

      for (const template of localizedTemplates) {
        for (const expanded of expandPath(template, langData)) {
          await apiDownload(url, expanded, token, langData);
        }
      }
    }
  } finally {
    if (originalLanguage) {
      warn("Restoring UI language to " + originalLanguage);
      try {
        await switchLanguage(url, token, originalLanguage);
      } catch (error) {
        // do not hide the original error (if any)
        warn(`WARNING: Cannot restore the UI language: ${error}`);
      }
    } else {
      warn("WARNING: Original UI language unknown, not restoring it.");
    }
  }

  return result;
}

// save the data as a pretty printed JSON file (2 spaces indentation)
function saveJson(file: string, data: any) {
  warn(`Writing ${file}`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// how long is the downloaded OpenAPI file valid
const CACHE_MAX_AGE_MS = 60 * 60 * 1000;

// download the OpenAPI file from an URL, use a local cache, resolves to the local file name
async function cachedDownload(apiUrl: string): Promise<string> {
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const cacheDir = path.join(cacheHome, "agama-dumper");
  const hash = crypto.createHash("sha256").update(apiUrl).digest("hex").slice(0, 16);
  const cacheFile = path.join(cacheDir, `${hash}.json`);

  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(cacheFile);
  } catch {
    // not cached yet
  }

  if (stat && Date.now() - stat.mtimeMs < CACHE_MAX_AGE_MS) {
    warn(`Using cached ${apiUrl} (${cacheFile})`);
    return cacheFile;
  }

  warn(`Downloading ${apiUrl}`);
  try {
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`HTTP code ${res.status}`);
    const body = await res.text();
    // check that it is a valid JSON before caching it
    JSON.parse(body);

    fs.mkdirSync(cacheDir, { recursive: true });
    // write atomically, do not leave a partial file in the cache
    const tmpFile = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, body);
    fs.renameSync(tmpFile, cacheFile);
    return cacheFile;
  } catch (error) {
    if (stat) {
      warn(`WARNING: Download of ${apiUrl} failed (${error}), using the outdated cache`);
      return cacheFile;
    }
    throw new Error(`Cannot download ${apiUrl}: ${error}`);
  }
}

// returns the list of OpenAPI files to read
async function openAPIFiles(source: string): Promise<string[]> {
  if (/^https?:\/\//.test(source)) {
    return [await cachedDownload(source)];
  }
  // sort the files to get a stable output
  return fs
    .globSync("*.json", { cwd: source })
    .sort()
    .map((f) => path.join(source, f));
}

async function readOpenAPI(source: string, baseUrl: string, password: string, outputDir: string) {
  // remove trailing slashes to avoid double slashes in the requests
  const url = baseUrl.replace(/\/+$/, "");
  const token = await login(url, password);
  const files = await openAPIFiles(source);
  const data: any = {};
  // paths with translated data, downloaded separately for each language
  const localized: string[] = [];
  // the same, but paths with parameters
  const localizedTemplates: string[] = [];

  for (const file of files) {
    const apiData = JSON.parse(fs.readFileSync(file, "utf-8"));
    const paths = apiData.paths || {};
    for (const name in paths) {
      if (!paths[name].get) continue;

      // not a data path, it only checks the login session
      if (name === "/api/auth") continue;

      if (name.includes("{")) {
        // paths with parameters need special handling
        if (isTranslated(paths[name])) {
          localizedTemplates.push(name);
        } else {
          warn(`Skipping ${name}`);
        }
      } else if (isTranslated(paths[name])) {
        localized.push(name);
      } else {
        await apiDownload(url, name, token, data);
      }
    }
  }

  const translated = await localizedPaths(url, token, localized, localizedTemplates);

  fs.mkdirSync(outputDir, { recursive: true });
  saveJson(path.join(outputDir, "dump.json"), data);

  for (const language in translated) {
    // the language comes from the server, do not allow path separators in the file name
    const safeName = language.replace(/[^A-Za-z0-9_-]/g, "_");
    saveJson(path.join(outputDir, `dump-${safeName}.json`), translated[language]);
  }

  sanityCheck(data);
}

// await cannot be used at the top level, define an anonymous async function and execute it
(async () => {
  try {
    await readOpenAPI(options.api, options.url, options.password, options.output);
  } catch (error) {
    warn(String(error));
    if (options.debug) {
      // print debug backtrace
      throw new Error("Agama dump failed", { cause: error });
    } else {
      process.exit(1);
    }
  }
})();
