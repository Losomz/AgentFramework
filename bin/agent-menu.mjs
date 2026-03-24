#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const repoUrl = process.env.AGENTFRAMEWORK_REPO_URL || 'https://github.com/Losomz/AI-Agents.git';
const cacheRoot = process.env.AGENTFRAMEWORK_HOME || path.join(os.homedir(), '.agentframework');
const runtimeDir = path.join(cacheRoot, 'runtime');
const runtimeEntry = path.join(runtimeDir, 'runtime', 'menu-runtime.mjs');

function resolveCommand(command) {
    if (process.platform !== 'win32') {
        return command;
    }

    return command;
}

function quoteWindowsArg(value) {
    if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
        return value;
    }

    return `"${value.replace(/"/g, '\\"')}"`;
}

function run(command, commandArgs, options = {}) {
    return new Promise((resolve, reject) => {
        const spawnCommand = process.platform === 'win32' && command === 'npm'
            ? 'cmd.exe'
            : resolveCommand(command);
        const spawnArgs = process.platform === 'win32' && command === 'npm'
            ? ['/d', '/s', '/c', ['npm', ...commandArgs].map(quoteWindowsArg).join(' ')]
            : commandArgs;
        const child = spawn(spawnCommand, spawnArgs, {
            cwd: options.cwd,
            stdio: options.stdio || 'inherit',
            shell: options.shell ?? false,
            env: process.env,
        });

        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} ${commandArgs.join(' ')} exited with code ${code ?? 'unknown'}`));
        });
    });
}

async function exists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function ensureGit() {
    try {
        await run('git', ['--version'], { stdio: 'ignore' });
    } catch {
        throw new Error('未检测到 git，请先安装 git 后再执行 agent-menu。');
    }
}

async function ensureRuntimeRepo() {
    await fs.mkdir(cacheRoot, { recursive: true });

    if (!await exists(path.join(runtimeDir, '.git'))) {
        console.log(`首次运行，正在拉取 AgentFramework runtime: ${repoUrl}`);
        await run('git', ['clone', repoUrl, runtimeDir]);
        return;
    }

    console.log('正在同步最新 AgentFramework runtime...');
    await run('git', ['pull', '--ff-only'], { cwd: runtimeDir });
}

async function ensureDependencies() {
    console.log('正在检查 runtime 依赖...');
    await run('npm', ['install', '--omit=dev', '--no-fund', '--no-audit'], { cwd: runtimeDir });
}

async function runRuntime() {
    await run(process.execPath, [runtimeEntry, ...args], { cwd: runtimeDir, shell: false });
}

async function main() {
    await ensureGit();
    await ensureRuntimeRepo();
    await ensureDependencies();

    if (!await exists(runtimeEntry)) {
        throw new Error(`未找到 runtime 入口: ${runtimeEntry}`);
    }

    await runRuntime();
}

main().catch((error) => {
    console.error('AgentFramework bootstrap 启动失败:', error.message);
    process.exitCode = 1;
});
