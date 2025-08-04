const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cors = require('cors');
const pidusage = require('pidusage');
const unzipper = require('unzipper');
const os = require('os');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const port = 3000;

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

let systemSettings = {
    adminSecret: process.env.ADMIN_SECRET || 'admin_secret_key',
    defaultMaxProjects: 10,
};

function loadDataFromFile(filePath, defaultData) {
    try {
        if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            return { ...defaultData, ...JSON.parse(fileContent) };
        } else {
            fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2), 'utf8');
            return defaultData;
        }
    } catch (error) {
        console.error(`Error loading file ${filePath}:`, error);
        return defaultData;
    }
}

systemSettings = loadDataFromFile(SETTINGS_PATH, systemSettings);

function saveDataToFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error(`Error saving file ${filePath}:`, error);
    }
}

const detectEnvironment = () => {
    if (process.env.REPL_ID) return { platform: 'Replit', detail: process.env.REPL_SLUG };
    return { platform: 'Local Machine', detail: os.hostname() };
};
const environmentInfo = detectEnvironment();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

let runningProcesses = {};
let processLogs = {};
let clients = new Map();

const PORT_RANGE_START = 4000;
const PORT_RANGE_END = 4999;
const usedPorts = new Set();

const portManager = {
    allocate: () => {
        for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
            if (!usedPorts.has(p)) {
                usedPorts.add(p);
                return p;
            }
        }
        return null;
    },
    release: (port) => {
        if (port) {
            usedPorts.delete(port);
        }
    }
};

const adminAuthMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'ไม่ได้รับอนุญาต: ไม่มี Authorization Header' });
    }
    const token = authHeader.split(' ')[1];
    if (token !== systemSettings.adminSecret) {
        return res.status(403).json({ message: 'ไม่ได้รับอนุญาต: Token ไม่ถูกต้อง' });
    }
    next();
};

function getProjectInfo(botFolderPath) {
    if (!fs.existsSync(botFolderPath)) {
        return { type: 'unknown', main: null, requirements: false, error: 'ไม่พบโฟลเดอร์โปรเจกต์' };
    }
    const files = fs.readdirSync(botFolderPath);
    const tsConfigPath = path.join(botFolderPath, 'tsconfig.json');
    const packageJsonPath = path.join(botFolderPath, 'package.json');

    if (fs.existsSync(tsConfigPath)) {
        const tsCandidates = ['index.ts', 'main.ts', 'app.ts', 'src/index.ts', 'src/main.ts'];
        for (const name of tsCandidates) {
            if (fs.existsSync(path.join(botFolderPath, name))) return { type: 'typescript', main: name, requirements: false };
        }
        const anyTsFile = files.find(file => file.endsWith('.ts'));
        if (anyTsFile) return { type: 'typescript', main: anyTsFile, requirements: false };
    }

    if (fs.existsSync(packageJsonPath)) {
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            if (packageJson.main && fs.existsSync(path.join(botFolderPath, packageJson.main))) {
                return { type: 'node', main: packageJson.main, requirements: false };
            }
        } catch (e) {
            console.error(`Error reading package.json for ${path.basename(botFolderPath)}:`, e);
        }
    }
    const jsCandidates = ['index.js', 'bot.js', 'main.js'];
    for (const name of jsCandidates) {
        if (files.includes(name)) return { type: 'node', main: name, requirements: false };
    }
    const anyJsFile = files.find(file => file.endsWith('.js'));
    if (anyJsFile) return { type: 'node', main: anyJsFile, requirements: false };

    const pyCandidates = ['main.py', 'app.py', 'bot.py'];
    for (const name of pyCandidates) {
        if (files.includes(name)) {
            return { type: 'python', main: name, requirements: fs.existsSync(path.join(botFolderPath, 'requirements.txt')) };
        }
    }
    const anyPyFile = files.find(file => file.endsWith('.py'));
    if (anyPyFile) {
        return { type: 'python', main: anyPyFile, requirements: fs.existsSync(path.join(botFolderPath, 'requirements.txt')) };
    }
    return { type: 'unknown', main: null, requirements: false, error: 'ไม่พบไฟล์สคริปต์หลัก (.js, .ts หรือ .py)' };
}

async function getUsageStats(pids) {
    if (!pids || pids.length === 0) return {};
    try {
        return await pidusage(pids);
    } catch (err) {
        return {};
    }
}

wss.on('connection', (ws) => {
    let botName = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'connect' && data.botName) {
                botName = data.botName;
                clients.set(botName, ws);
                console.log(`[WebSocket] Client connected for bot: ${botName}`);

                if (processLogs[botName]) {
                    ws.send(JSON.stringify({ type: 'log', data: processLogs[botName] }));
                }
            } else if (data.type === 'input' && botName && runningProcesses[botName]) {
                runningProcesses[botName].process.stdin.write(data.data + '\n');
            }
        } catch (e) {
            console.error('[WebSocket] Invalid message format:', message);
        }
    });

    ws.on('close', () => {
        if (botName) {
            clients.delete(botName);
            console.log(`[WebSocket] Client disconnected for bot: ${botName}`);
        }
    });

    ws.on('error', (error) => {
        console.error('[WebSocket] An error occurred:', error);
    });
});

app.get('/api/admin/settings', adminAuthMiddleware, (req, res) => {
    res.json({
        defaultMaxProjects: systemSettings.defaultMaxProjects
    });
});

app.post('/api/admin/settings', adminAuthMiddleware, (req, res) => {
    const { defaultMaxProjects } = req.body;
    if (typeof defaultMaxProjects === 'number' && defaultMaxProjects >= 0) {
        systemSettings.defaultMaxProjects = defaultMaxProjects;
    }
    saveDataToFile(SETTINGS_PATH, systemSettings);
    res.json({ message: 'บันทึกการตั้งค่าสำเร็จ', newSettings: systemSettings });
});

app.get('/api/admin/active-info', adminAuthMiddleware, (req, res) => {
    try {
        const projectFolders = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        const projectDetails = projectFolders.map(botName => {
            const processInfo = runningProcesses[botName];
            return {
                name: botName,
                isRunning: !!processInfo,
                port: processInfo ? processInfo.port : null,
                pid: processInfo ? processInfo.pid : null
            };
        });

        const projectCount = projectFolders.length;

        res.json({
            totalProjects: projectCount,
            maxProjects: systemSettings.defaultMaxProjects,
            projects: projectDetails
        });
    } catch (error) {
        console.error("Error in /api/admin/active-info:", error);
        res.status(500).json({ message: "ไม่สามารถดึงข้อมูลโปรเจกต์ได้" });
    }
});

app.get('/api/scripts', async (req, res) => {
    try {
        const entries = await fs.promises.readdir(UPLOADS_DIR, { withFileTypes: true });
        const botFolders = entries.filter(e => e.isDirectory()).map(e => e.name);

        const runningBotPIDs = Object.values(runningProcesses).map(p => p.pid).filter(Boolean);
        const stats = await getUsageStats(runningBotPIDs);

        const scriptDetails = botFolders.map(name => {
            const botFolderPath = path.join(UPLOADS_DIR, name);
            const projectInfo = getProjectInfo(botFolderPath);
            const processInfo = runningProcesses[name];

            let details = { name, status: 'stopped', type: projectInfo.type };
            if (processInfo && processInfo.pid) {
                const pStats = stats[processInfo.pid];
                details.status = 'running';
                details.pid = processInfo.pid;
                details.startTime = processInfo.startTime;
                details.port = processInfo.port;
                details.cpu = pStats ? pStats.cpu.toFixed(1) : 0;
                details.memory = pStats ? (pStats.memory / 1024 / 1024).toFixed(1) : 0;
                details.ping = Math.floor(Math.random() * 30) + 5;
            }
            return details;
        });
        res.json({ scripts: scriptDetails });
    } catch (err) {
        console.error("Error in /api/scripts:", err);
        res.status(500).json({ message: 'เกิดข้อผิดพลาดในการอ่านรายชื่อโปรเจกต์' });
    }
});

app.post('/api/run', (req, res) => {
    const { script: botName } = req.body;

    if (!botName || runningProcesses[botName]) {
        return res.status(400).json({ message: 'คำขอไม่ถูกต้อง หรือโปรเจกต์กำลังทำงานอยู่แล้ว' });
    }

    const botFolderPath = path.join(UPLOADS_DIR, botName);
    const projectInfo = getProjectInfo(botFolderPath);

    if (projectInfo.type === 'unknown' || !projectInfo.main) {
        return res.status(404).json({ message: projectInfo.error || 'ไม่สามารถหาไฟล์หลักของโปรเจกต์ได้' });
    }

    const allocatedPort = portManager.allocate();
    if (allocatedPort === null) {
        return res.status(503).json({ message: 'ไม่สามารถเริ่มโปรเจกต์ได้: ไม่มีพอร์ตว่าง' });
    }

    const sendToClient = (data) => {
        const logData = data.toString();
        processLogs[botName] = (processLogs[botName] || '') + logData;
        if (clients.has(botName)) {
            clients.get(botName).send(JSON.stringify({ type: 'log', data: logData }));
        }
    };

    const startProcess = (command, args) => {
        const spawnOptions = {
            cwd: botFolderPath,
            stdio: 'pipe',
            shell: false,
            env: {
                ...process.env,
                PORT: allocatedPort
            }
        };
        const child = spawn(command, args, spawnOptions);

        runningProcesses[botName] = {
            process: child,
            pid: child.pid,
            startTime: Date.now(),
            port: allocatedPort,
            logBuffer: '',
            logTimer: null
        };
        processLogs[botName] = '';

        const processInfo = runningProcesses[botName];

        const bufferAndSendData = (chunk) => {
            if (!processInfo) return;
            processInfo.logBuffer += chunk.toString();
            if (processInfo.logTimer) clearTimeout(processInfo.logTimer);
            processInfo.logTimer = setTimeout(() => {
                if (processInfo.logBuffer.length > 0) {
                    sendToClient(processInfo.logBuffer);
                    processInfo.logBuffer = '';
                }
                processInfo.logTimer = null;
            }, 50);
        };

        child.stdout.on('data', bufferAndSendData);
        child.stderr.on('data', bufferAndSendData);

        child.on('close', (code) => {
            if (processInfo) {
                if (processInfo.logTimer) clearTimeout(processInfo.logTimer);
                if (processInfo.logBuffer.length > 0) sendToClient(processInfo.logBuffer);
            }
            const exitLog = `\n-------------------------------------\n[System] โปรเจกต์หยุดทำงานด้วย exit code ${code}.\n`;
            sendToClient(exitLog);

            if (clients.has(botName)) {
                clients.get(botName).send(JSON.stringify({ type: 'exit', code: code }));
            }

            portManager.release(allocatedPort);
            delete runningProcesses[botName];
        });

        child.on('error', (e) => {
            sendToClient(`\n[System] เกิดข้อผิดพลาดในการเริ่มโปรเซส: ${e.message}\n`);
            portManager.release(allocatedPort);
            delete runningProcesses[botName];
        });
        res.json({ message: `โปรเจกต์ ${botName} เริ่มทำงานแล้วบนพอร์ต ${allocatedPort}` });
    };

    const installAndStart = (installCmd, installArgs, startCmd, startArgs) => {
        let installLog = `[System] กำลังติดตั้ง dependencies...\n$ ${installCmd} ${installArgs.join(' ')}\n\n`;
        sendToClient(installLog);
        const installer = spawn(installCmd, installArgs, { cwd: botFolderPath, shell: true });
        installer.stdout.on('data', sendToClient);
        installer.stderr.on('data', sendToClient);
        installer.on('close', (code) => {
            if (code === 0) {
                sendToClient(`\n[System] ติดตั้งสำเร็จ กำลังเริ่มโปรเจกต์บนพอร์ต ${allocatedPort}...\n`);
                startProcess(startCmd, startArgs);
            } else {
                const failMsg = `\n[System] การติดตั้ง dependencies ล้มเหลวด้วย exit code ${code}.\n`;
                sendToClient(failMsg);
                portManager.release(allocatedPort);
            }
        });
        installer.on('error', (err) => {
            const errorMsg = `[System] เกิดข้อผิดพลาดขณะรันตัวติดตั้ง: ${err.message}\n`;
            sendToClient(errorMsg);
            portManager.release(allocatedPort);
        });
    };

    if (projectInfo.type === 'node') {
        const hasPackageJson = fs.existsSync(path.join(botFolderPath, 'package.json'));
        const hasNodeModules = fs.existsSync(path.join(botFolderPath, 'node_modules'));
        if (hasPackageJson && !hasNodeModules) {
            installAndStart('npm', ['install'], 'node', [projectInfo.main]);
        } else {
            startProcess('node', [projectInfo.main]);
        }
    } else if (projectInfo.type === 'typescript') {
        const hasPackageJson = fs.existsSync(path.join(botFolderPath, 'package.json'));
        const hasNodeModules = fs.existsSync(path.join(botFolderPath, 'node_modules'));
        if (hasPackageJson && !hasNodeModules) {
            installAndStart('npm', ['install'], 'npx', ['ts-node', projectInfo.main]);
        } else {
            startProcess('npx', ['ts-node', projectInfo.main]);
        }
    } else if (projectInfo.type === 'python') {
        if (projectInfo.requirements) {
            installAndStart('python', ['-m', 'pip', 'install', '-r', 'requirements.txt'], 'python', [projectInfo.main]);
        } else {
            startProcess('python', [projectInfo.main]);
        }
    }
});

// [แก้ไข] เปลี่ยน /api/install ให้ส่ง Log ผ่าน WebSocket แบบ Real-time
app.post('/api/install', (req, res) => {
    const { module, botName } = req.body;
    if (!botName || !module) {
        return res.status(400).json({ message: 'ข้อมูลไม่ถูกต้อง: ไม่ได้ระบุชื่อโปรเจกต์หรือโมดูล' });
    }

    const botFolderPath = path.join(UPLOADS_DIR, botName);
    if (!fs.existsSync(botFolderPath)) {
        return res.status(404).json({ message: 'ไม่พบโปรเจกต์' });
    }

    // ฟังก์ชันสำหรับส่งข้อมูลไปยัง client ผ่าน WebSocket
    const sendToClient = (data) => {
        const logData = data.toString();
        // เพิ่ม log ไปยัง buffer หลักเพื่อให้สามารถเรียกดูย้อนหลังได้
        processLogs[botName] = (processLogs[botName] || '') + logData;
        if (clients.has(botName)) {
            clients.get(botName).send(JSON.stringify({ type: 'log', data: logData }));
        }
    };

    const projectInfo = getProjectInfo(botFolderPath);
    let command, args;

    if (projectInfo.type === 'node' || projectInfo.type === 'typescript') {
        command = 'npm';
        args = ['install', module];
    } else if (projectInfo.type === 'python') {
        command = 'python';
        args = ['-m', 'pip', 'install', module];
    } else {
        return res.status(400).json({ message: 'ไม่สามารถติดตั้งโมดูลสำหรับโปรเจกต์ประเภทนี้ได้' });
    }

    const installer = spawn(command, args, { cwd: botFolderPath, shell: true });

    sendToClient(`\n[System] เริ่มการติดตั้ง '${module}'...\n$ ${command} ${args.join(' ')}\n\n`);

    installer.stdout.on('data', sendToClient);
    installer.stderr.on('data', sendToClient);

    installer.on('close', (code) => {
        const endMsg = code === 0
            ? `\n[System] การติดตั้ง '${module}' สำเร็จ\n`
            : `\n[System] การติดตั้ง '${module}' ล้มเหลว (Exit Code: ${code})\n`;
        sendToClient(endMsg);
        if (clients.has(botName)) {
            // ส่ง event บอก client ว่าการติดตั้งเสร็จสิ้น
            clients.get(botName).send(JSON.stringify({ type: 'install_end', success: code === 0 }));
        }
    });

    installer.on('error', (err) => {
        const errorMsg = `[System] เกิดข้อผิดพลาดในการเรียกตัวติดตั้ง: ${err.message}\n`;
        sendToClient(errorMsg);
        if (clients.has(botName)) {
            clients.get(botName).send(JSON.stringify({ type: 'install_end', success: false }));
        }
    });

    // ตอบกลับทันทีว่าเริ่มกระบวนการแล้ว
    res.json({ message: `เริ่มการติดตั้ง '${module}' แล้ว โปรดตรวจสอบหน้า Console สำหรับความคืบหน้า` });
});


app.post('/api/stop', (req, res) => {
    const { script: botName } = req.body;
    if (!botName) return res.status(400).json({ message: 'ไม่ได้ระบุชื่อโปรเจกต์' });
    const processInfo = runningProcesses[botName];
    if (!processInfo) return res.status(400).json({ message: 'โปรเจกต์ไม่ได้ทำงานอยู่' });

    processInfo.process.kill('SIGKILL');
    res.json({ message: `ส่งสัญญาณหยุดไปที่ ${botName} แล้ว` });
});

app.delete('/api/scripts/:botName', (req, res) => {
    const { botName } = req.params;
    if (runningProcesses[botName]) {
        return res.status(400).json({ message: 'ต้องหยุดโปรเจกต์ก่อนลบ' });
    }
    const botFolderPath = path.join(UPLOADS_DIR, botName);
    if (!fs.existsSync(botFolderPath)) return res.status(404).json({ message: 'ไม่พบโปรเจกต์' });
    fs.rm(botFolderPath, { recursive: true, force: true }, e => {
        if (e) return res.status(500).json({ message: 'ไม่สามารถลบโฟลเดอร์ได้' });
        delete processLogs[botName];
        res.json({ message: `โปรเจกต์ ${botName} ถูกลบแล้ว` });
    });
});

// API สำหรับดึงข้อมูล Log ของโปรเจกต์
app.get('/api/logs/:botName', (req, res) => {
    const { botName } = req.params;
    const logs = processLogs[botName] || ''; // ดึง log จาก memory, ถ้าไม่มีให้ใช้ค่าว่าง
    res.json({ logs });
});

app.get('/api/environment', (req, res) => res.json(environmentInfo));

const projectCreationStorage = multer.memoryStorage();
const projectCreationUploader = multer({ storage: projectCreationStorage });

app.post('/api/upload/project', projectCreationUploader.single('file'), async (req, res) => {
    const maxProjects = systemSettings.defaultMaxProjects;

    try {
        const existingProjects = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory());
        if (existingProjects.length >= maxProjects) {
            return res.status(403).json({ message: `สร้างโปรเจกต์ไม่สำเร็จ: คุณสร้างโปรเจกต์ได้สูงสุด ${maxProjects} โปรเจกต์เท่านั้น` });
        }
    } catch (e) {
        console.error("Error reading project directory for quota check:", e);
        return res.status(500).json({ message: 'เกิดข้อผิดพลาดในการตรวจสอบโควต้าโปรเจกต์' });
    }
    
    const { botName, creationMethod, gitUrl } = req.body;

    if (!botName || !/^[a-zA-Z0-9._\u0E00-\u0E7F-]+$/u.test(botName)) {
        return res.status(400).json({ message: 'ชื่อโฟลเดอร์ไม่ถูกต้อง (ใช้ได้เฉพาะ a-z, ก-ฮ, 0-9, -, _, .)' });
    }
    const botFolderPath = path.join(UPLOADS_DIR, botName);
    if (fs.existsSync(botFolderPath)) {
        return res.status(400).json({ message: `โปรเจกต์ชื่อ '${botName}' มีอยู่แล้ว` });
    }

    try {
        await fs.promises.mkdir(botFolderPath, { recursive: true });

        if (creationMethod === 'git') {
            if (!gitUrl || !/(?:git|ssh|https?|git@[-\w.]+):(\/\/)?(.*?)(\.git)(\/?|\#[-\d\w._]+?)$/.test(gitUrl)) {
                 throw new Error('URL ของ Git Repository ไม่ถูกต้อง');
            }
            
            await new Promise((resolve, reject) => {
                const gitProcess = spawn('git', ['clone', gitUrl, '.'], { cwd: botFolderPath });
                let output = '';
                gitProcess.stdout.on('data', (data) => output += data.toString());
                gitProcess.stderr.on('data', (data) => output += data.toString());
                gitProcess.on('close', (code) => {
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`การโคลนล้มเหลว (Exit code: ${code})\n${output}`));
                    }
                });
                gitProcess.on('error', (err) => reject(new Error(`เกิดข้อผิดพลาดในการรันคำสั่ง git: ${err.message}`)));
            });

            return res.json({ message: `โคลนโปรเจกต์ '${botName}' จาก Git สำเร็จ` });
        }

        if (creationMethod === 'empty') {
            return res.json({ message: `สร้างโปรเจกต์ว่าง '${botName}' สำเร็จ` });
        }
        if (!req.file) {
            throw new Error('ไม่ได้เลือกไฟล์สำหรับอัปโหลด');
        }
        const fileExt = path.extname(req.file.originalname).toLowerCase();
        if (creationMethod === 'js' && (fileExt === '.js' || fileExt === '.py')) {
            await fs.promises.writeFile(path.join(botFolderPath, req.file.originalname), req.file.buffer);
            return res.json({ message: `สร้างโปรเจกต์ '${botName}' ด้วยไฟล์ ${req.file.originalname} สำเร็จ` });
        }
        if (creationMethod === 'zip' && fileExt === '.zip') {
            const directory = await unzipper.Open.buffer(req.file.buffer);
            const topLevelEntries = new Set(directory.files.filter(file => !file.path.startsWith('__MACOSX/')).map(file => file.path.split('/')[0]).filter(Boolean));
            let pathPrefixToStrip = '';
            if (topLevelEntries.size === 1) {
                const singleRoot = topLevelEntries.values().next().value;
                const isDirectory = directory.files.some(file => file.path === `${singleRoot}/` && file.type === 'Directory');
                if (isDirectory) pathPrefixToStrip = `${singleRoot}/`;
            }
            const stream = require('stream');
            const extractStream = stream.Readable.from(req.file.buffer).pipe(unzipper.Parse());
            const extractionPromises = [];
            extractStream.on('entry', (entry) => {
                try {
                    if (entry.path.startsWith('__MACOSX/')) {
                        entry.autodrain(); return;
                    }
                    let finalPath = entry.path.substring(pathPrefixToStrip.length);
                    if (!finalPath) {
                        entry.autodrain(); return;
                    }
                    const fullDestPath = path.join(botFolderPath, finalPath);
                    if (entry.type === 'Directory') {
                        fs.promises.mkdir(fullDestPath, { recursive: true });
                        entry.autodrain();
                    } else {
                        const writePromise = new Promise(async (resolve, reject) => {
                            try {
                                await fs.promises.mkdir(path.dirname(fullDestPath), { recursive: true });
                                entry.pipe(fs.createWriteStream(fullDestPath)).on('finish', resolve).on('error', reject);
                            } catch (err) { reject(err); }
                        });
                        extractionPromises.push(writePromise);
                    }
                } catch (e) {
                    entry.autodrain();
                }
            });
            await new Promise((resolve, reject) => {
                extractStream.on('finish', () => Promise.all(extractionPromises).then(resolve).catch(reject));
                extractStream.on('error', reject);
            });
            return res.json({ message: `สร้างโปรเจกต์ '${botName}' จากไฟล์ ZIP สำเร็จ` });
        }
        throw new Error('ประเภทไฟล์หรือวิธีสร้างไม่ถูกต้อง');
    } catch (err) {
        fs.rm(botFolderPath, { recursive: true, force: true }, () => { });
        res.status(500).json({ message: `เกิดข้อผิดพลาด: ${err.message}` });
    }
});

const fileManagerStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const { botName, currentPath = '.' } = req.body;
        if (!botName) return cb(new Error('ไม่พบชื่อโปรเจกต์ (botName) ในคำขอ'));
        const projectRootPath = path.join(UPLOADS_DIR, botName);
        const safeSubPath = path.normalize(currentPath).replace(/^(\.\.[/\\])+/, '');
        const destinationPath = path.join(projectRootPath, safeSubPath);
        if (!destinationPath.startsWith(projectRootPath)) return cb(new Error('พาธไม่ถูกต้อง'));
        fs.mkdir(destinationPath, { recursive: true }, (err) => {
            if (err) {
                console.error("Error creating upload destination folder:", err);
                return cb(err);
            }
            cb(null, destinationPath);
        });
    },
    filename: (req, file, cb) => {
        cb(null, path.basename(file.originalname));
    },
});
const fileManagerUploader = multer({ storage: fileManagerStorage });

app.get('/api/files/:botName', async (req, res) => {
    const { botName } = req.params;
    const { path: subPath = '.' } = req.query;
    const safeSubPath = path.normalize(subPath).replace(/^(\.\.[/\\])+/, '');
    const fullPath = path.join(UPLOADS_DIR, botName, safeSubPath);
    if (!fs.existsSync(fullPath) || !fullPath.startsWith(UPLOADS_DIR)) {
        return res.status(404).json({ message: 'ไม่พบโปรเจกต์หรือพาธที่ระบุ' });
    }
    try {
        const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
        const files = entries.map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })).sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name, 'en', { numeric: true });
        });
        res.json({ files });
    } catch (err) {
        res.status(500).json({ message: 'ไม่สามารถอ่านรายการไฟล์ได้' });
    }
});

app.post('/api/files/upload', fileManagerUploader.array('files'), (req, res) => {
    res.json({ message: `อัปโหลด ${req.files.length} ไฟล์สำเร็จ` });
});

async function createFilesystemEntry(req, res, type) {
    const { botName, currentPath = '', fileName, folderName } = req.body;
    const name = fileName || folderName;

    if (!botName || !name || name.trim() === '' || name.includes('/') || name.includes('\\')) {
        return res.status(400).json({ message: 'ข้อมูลไม่ถูกต้อง: ชื่อไฟล์/โฟลเดอร์ไม่ถูกต้อง' });
    }

    const safeSubPath = path.normalize(currentPath).replace(/^(\.\.[/\\])+/, '');
    const projectRootPath = path.join(UPLOADS_DIR, botName);
    const fullPath = path.join(projectRootPath, safeSubPath, name);

    if (!fullPath.startsWith(projectRootPath)) {
        return res.status(400).json({ message: 'พาธไม่ถูกต้อง: พยายามเข้าถึงนอกโฟลเดอร์โปรเจกต์' });
    }

    if (fs.existsSync(fullPath)) {
        return res.status(400).json({ message: `มีไฟล์หรือโฟลเดอร์ชื่อ '${name}' อยู่แล้ว` });
    }

    try {
        if (type === 'file') {
            await fs.promises.writeFile(fullPath, '', 'utf8');
        } else {
            await fs.promises.mkdir(fullPath);
        }
        res.json({ message: `สร้าง ${type} '${name}' สำเร็จ` });
    } catch (err) {
        res.status(500).json({ message: `ไม่สามารถสร้าง ${type} ได้: ${err.message}` });
    }
}

app.post('/api/files/create', (req, res) => createFilesystemEntry(req, res, 'file'));
app.post('/api/files/create-folder', (req, res) => createFilesystemEntry(req, res, 'directory'));

app.delete('/api/files/delete', async (req, res) => {
    const { botName, filePath } = req.body;
    if (!botName || !filePath) return res.status(400).json({ message: 'ข้อมูลไม่ถูกต้อง' });
    const safeFilePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    const projectRootPath = path.join(UPLOADS_DIR, botName);
    const fullPath = path.join(projectRootPath, safeFilePath);

    if (!fullPath.startsWith(projectRootPath) || !fs.existsSync(fullPath)) {
        return res.status(404).json({ message: 'ไม่พบไฟล์หรือโฟลเดอร์ หรือพาธไม่ถูกต้อง' });
    }
    try {
        await fs.promises.rm(fullPath, { recursive: true, force: true });
        res.json({ message: `ลบ '${path.basename(fullPath)}' สำเร็จ` });
    } catch (err) {
        res.status(500).json({ message: `ไม่สามารถลบได้: ${err.message}` });
    }
});

app.post('/api/files/rename', async (req, res) => {
    const { botName, oldPath, newName } = req.body;
    if (!botName || !oldPath || !newName || newName.includes('/') || newName.includes('\\')) {
        return res.status(400).json({ message: 'ข้อมูลไม่ถูกต้อง' });
    }
    const safeOldPath = path.normalize(oldPath).replace(/^(\.\.[/\\])+/, '');
    const projectRootPath = path.join(UPLOADS_DIR, botName);
    const fullOldPath = path.join(projectRootPath, safeOldPath);
    const fullNewPath = path.join(path.dirname(fullOldPath), newName);

    if (!fullOldPath.startsWith(projectRootPath) || !fs.existsSync(fullOldPath)) return res.status(404).json({ message: 'ไม่พบต้นทางหรือพาธไม่ถูกต้อง' });
    if (!fullNewPath.startsWith(projectRootPath)) return res.status(400).json({ message: 'พาธใหม่ไม่ถูกต้อง' });
    if (fs.existsSync(fullNewPath)) return res.status(400).json({ message: 'มีไฟล์หรือโฟลเดอร์ชื่อนี้อยู่แล้ว' });

    try {
        await fs.promises.rename(fullOldPath, fullNewPath);
        res.json({ message: `เปลี่ยนชื่อเป็น '${newName}' สำเร็จ` });
    } catch (err) {
        res.status(500).json({ message: `ไม่สามารถเปลี่ยนชื่อได้: ${err.message}` });
    }
});

app.get('/api/file/content', async (req, res) => {
    const { botName, fileName } = req.query;
    if (!botName || !fileName) return res.status(400).json({ message: 'ข้อมูลไม่ถูกต้อง' });
    const safeFilePath = path.normalize(fileName).replace(/^(\.\.[/\\])+/, '');
    const projectRootPath = path.join(UPLOADS_DIR, botName);
    const filePath = path.join(projectRootPath, safeFilePath);

    if (!filePath.startsWith(projectRootPath) || !fs.existsSync(filePath)) return res.status(404).json({ message: 'ไม่พบไฟล์หรือพาธไม่ถูกต้อง' });
    try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        res.json({ content });
    } catch (err) {
        res.status(500).json({ message: 'ไม่สามารถอ่านไฟล์ได้' });
    }
});

app.post('/api/file/content', async (req, res) => {
    const { botName, fileName, content } = req.body;
    if (!botName || !fileName || content === undefined) return res.status(400).json({ message: 'ข้อมูลไม่ถูกต้อง' });
    const safeFilePath = path.normalize(fileName).replace(/^(\.\.[/\\])+/, '');
    const projectRootPath = path.join(UPLOADS_DIR, botName);
    const filePath = path.join(projectRootPath, safeFilePath);

    if (!filePath.startsWith(projectRootPath) || !fs.existsSync(filePath)) return res.status(404).json({ message: 'ไม่พบไฟล์หรือพาธไม่ถูกต้อง' });
    try {
        await fs.promises.writeFile(filePath, content, 'utf-8');
        res.json({ message: 'บันทึกไฟล์สำเร็จ' });
    } catch (err) {
        res.status(500).json({ message: `ไม่สามารถบันทึกไฟล์ได้: ${err.message}` });
    }
});

server.listen(port, '0.0.0.0', () => {
    console.log(`[INFO] HTTP & WebSocket server is running on all interfaces, port ${port}`);
});

