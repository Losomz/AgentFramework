#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import prompts from 'prompts';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = path.join(rootDir, '.agents', 'skills');

const templateCatalog = [
    {
        value: 'cocos-developer-template',
        title: 'Cocos 开发模板',
        description: '适用于 Cocos 开发场景，强调稳定实现、日志、文档与极简改动。',
        items: [
            'cocos-developer',
            'cocos-general',
            'cocos-code-review',
            'chinese-encoding',
        ],
    },
];

const args = new Set(process.argv.slice(2));

async function readInstalledSkills() {
    try {
        const entries = await fs.readdir(skillsDir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

function printHeader(installedSkills) {
    console.clear();
    console.log('====================================');
    console.log('         AgentFramework Menu        ');
    console.log('====================================');
    console.log(`当前目录: ${process.cwd()}`);
    console.log(`runtime 仓库: ${rootDir}`);
    console.log(`已发现 skills: ${installedSkills.length}`);
    console.log('');
}

async function showTemplateCatalog() {
    console.log('可用模板：');
    for (const template of templateCatalog) {
        console.log(`- ${template.title}`);
        console.log(`  ${template.description}`);
        console.log(`  包含: ${template.items.join(', ')}`);
    }
    console.log('');
}

async function showInstalledSkills(installedSkills) {
    console.log('当前 runtime 中可用的 skills：');
    if (installedSkills.length === 0) {
        console.log('- 暂未发现 skill');
    } else {
        for (const skill of installedSkills) {
            console.log(`- ${skill}`);
        }
    }
    console.log('');
}

async function handleTemplateSelection() {
    const { template } = await prompts({
        type: 'select',
        name: 'template',
        message: '请选择要拉取的模板',
        choices: templateCatalog.map((item) => ({
            title: item.title,
            description: item.description,
            value: item.value,
        })),
    }, {
        onCancel: () => {
            throw new Error('cancelled');
        },
    });

    const selected = templateCatalog.find((item) => item.value === template);
    if (!selected) {
        console.log('未找到所选模板。');
        return;
    }

    console.log('');
    console.log(`已选择模板: ${selected.title}`);
    console.log(`说明: ${selected.description}`);
    console.log(`将包含: ${selected.items.join(', ')}`);
    console.log('');
    console.log('当前版本已改为 bootstrap + git runtime 模式。');
    console.log('后续会在这里接入模板同步到当前项目的逻辑。');
    console.log('');
}

async function main() {
    const installedSkills = await readInstalledSkills();

    if (args.has('--list-templates')) {
        await showTemplateCatalog();
        return;
    }

    if (args.has('--list-skills')) {
        await showInstalledSkills(installedSkills);
        return;
    }

    printHeader(installedSkills);

    try {
        while (true) {
            const { action } = await prompts({
                type: 'select',
                name: 'action',
                message: '请选择操作',
                choices: [
                    { title: '拉取模板到当前项目', value: 'pull-template' },
                    { title: '查看可用模板', value: 'list-templates' },
                    { title: '查看当前 runtime 可用 skills', value: 'list-skills' },
                    { title: '退出', value: 'exit' },
                ],
            }, {
                onCancel: () => {
                    throw new Error('cancelled');
                },
            });

            console.log('');

            if (action === 'pull-template') {
                await handleTemplateSelection();
            } else if (action === 'list-templates') {
                await showTemplateCatalog();
            } else if (action === 'list-skills') {
                await showInstalledSkills(installedSkills);
            } else if (action === 'exit') {
                console.log('已退出 AgentFramework Menu。');
                break;
            }
        }
    } catch (error) {
        if (error instanceof Error && error.message === 'cancelled') {
            console.log('\n已取消操作。');
            return;
        }
        throw error;
    }
}

main().catch((error) => {
    console.error('CLI runtime 启动失败:', error);
    process.exitCode = 1;
});
