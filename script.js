/**
 * Intelligent Evacuation Guidance System
 * Core Logic
 */
class EvacuationSystem {
    constructor() {
        console.log("System Initializing...");

        this.canvas = document.getElementById('floorPlanCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.floorSelect = document.getElementById('floorSelect');
        this.statusPanel = document.getElementById('statusPanel');
        this.statusText = this.statusPanel.querySelector('.status-indicator');
        this.modeBtns = document.querySelectorAll('.mode-btn');
        this.overlayMsg = document.getElementById('overlayMessage');

        // State
        this.currentFloor = 1;
        this.mode = 'view'; // 'view' or 'fire'
        this.gridSize = 30; // px per cell
        this.width = 0;
        this.height = 0;

        // Simulation State
        this.socket = (typeof io !== 'undefined') ? io() : null;
        this.isOnline = !!this.socket;
        this.myId = null;
        this.users = []; // Synced from server
        this.fireLocations = []; // Synced from server
        this.exits = [];
        this.walls = []; // Array of {x, y}

        // Voice Navigation State
        this.lastInstruction = "";
        this.lastSpeakTime = 0;

        this.role = 'civilian'; // 'civilian' or 'firefighter'

        // Real-World State
        this.customMap = null;
        this.calibrated = false;
        this.calibrationPoints = []; // [ {pixel: {x,y}, gps: {lat,lon}} ]
        this.lastClick = null;

        this.init();
    }

    init() {
        this.resize();
        window.addEventListener('resize', () => this.resize());

        // Load Floor 1 by default
        this.loadFloor(1);

        this.setupRealWorld();

        // Event Listeners
        this.floorSelect.addEventListener('change', (e) => this.loadFloor(parseInt(e.target.value)));

        const roleSelect = document.getElementById('roleSelect');
        if (roleSelect) {
            roleSelect.addEventListener('change', (e) => {
                this.role = e.target.value;
                // Force update position to broadcast new role
                if (this.isOnline) {
                    // We need to resend current position with new role
                    // Find 'me' to get current coords
                    const me = this.users.find(u => u.id === this.myId);
                    if (me) {
                        this.socket.emit('updateUser', { x: me.x, y: me.y, floor: this.currentFloor, role: this.role });
                    }
                }
            });
        }

        this.modeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this.modeBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.mode = btn.dataset.mode;

                if (this.mode === 'fire') {
                    this.overlayMsg.textContent = "Click anywhere on the map to start a FIRE";
                    this.overlayMsg.style.display = 'block';
                    this.overlayMsg.style.color = '#ff3333';
                } else {
                    this.overlayMsg.textContent = "Click to ADD PEOPLE";
                    this.overlayMsg.style.display = 'block';
                    this.overlayMsg.style.color = '#22c55e';
                }
            });
        });

        // Clear Fire Button
        const clearBtn = document.getElementById('clearFireBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (confirm("Are you sure you want to extinguish all fires on this floor?")) {
                    if (this.isOnline) {
                        this.socket.emit('clearFire', { floor: this.currentFloor });
                    } else {
                        // Offline Clear
                        this.fireLocations = this.fireLocations.filter(f => f.floor !== this.currentFloor);
                        this.updateStatus(false); // Assuming no fire on other floors for offline simplicity or complex check
                        this.recalculate();
                    }
                }
            });
        }


        this.canvas.addEventListener('click', (e) => {
            this.unlockVoice(); // Unlock on map click too
            this.handleClick(e)
        });

        // Network Initialization
        if (this.isOnline) {
            // Socket Listeners
            this.socket.on('init', (data) => {
                this.myId = data.id;
                this.users = data.users.map(u => ({ ...u, path: [] })); // Add path property LOCALLY
                this.fireLocations = data.fireLocations;
                this.recalculate();
            });

            this.socket.on('stateUpdate', (data) => {
                // Merge existing paths if possible to avoid flickering, or just recalc
                // Simplified: just update positions and recalc paths locally
                this.users = data.users.map(u => ({ ...u, path: [] }));
                this.fireLocations = data.fireLocations;

                // Re-identify "Me" in the list
                this.updateStatus(this.fireLocations.length > 0);
                this.recalculate();
            });
        } else {
            console.warn("Socket.IO not found. Running in Offline Mode.");
            this.overlayMsg.textContent = "OFFLINE MODE - Server not running";
            this.overlayMsg.style.display = 'block';
            this.overlayMsg.style.color = 'orange';

            // Spawn dummy users for demo
            this.spawnUsers(5);
        }

        // Animation Loop
        this.animate();
    }

    resize() {
        const parent = this.canvas.parentElement;
        this.canvas.width = parent.clientWidth;
        this.canvas.height = parent.clientHeight;
        this.width = Math.floor(this.canvas.width / this.gridSize);
        this.height = Math.floor(this.canvas.height / this.gridSize);
        this.loadFloor(this.currentFloor); // Reload to fit grid
    }

    loadFloor(floorNum) {
        this.currentFloor = floorNum;
        this.walls = [];
        this.exits = [];
        this.fireLocations = [];
        this.users = [];
        this.updateStatus(false);

        // Procedural generation of simple layouts based on floor
        // In a real app, this would come from a JSON/Database
        const w = this.width;
        const h = this.height;

        // Common Bounds
        for (let x = 0; x < w; x++) { this.walls.push({ x, y: 0 }); this.walls.push({ x, y: h - 1 }); }
        for (let y = 0; y < h; y++) { this.walls.push({ x: 0, y }); this.walls.push({ x: w - 1, y }); }

        if (floorNum === 1) {
            // Lecture Hall Layout (User Requested)
            // Layout: Stepped rows of desks, central aisle, 2 exits (Front/Back)

            const aisleWidth = 4;
            const rowDepth = 2; // Desk depth
            const rowGap = 3;   // Walking space between rows
            const sideMargin = 2;

            // Front Area (Stage/Screen)
            // Clear space at y=0 to y=5

            // Rows of Desks
            for (let y = 6; y < h - 5; y += (rowDepth + rowGap)) {
                // Left Block of Desks
                this.addToWalls(sideMargin, y, (w / 2) - sideMargin - (aisleWidth / 2), rowDepth);

                // Right Block of Desks
                this.addToWalls((w / 2) + (aisleWidth / 2), y, (w / 2) - sideMargin - (aisleWidth / 2), rowDepth);
            }

            // Exits
            // Front Exit (Top)
            this.exits.push({ x: Math.floor(w / 2), y: 1 });
            // Back Exit (Bottom)
            this.exits.push({ x: Math.floor(w / 2), y: h - 2 });
            this.exits.push({ x: w - 2, y: h - 2 }); // Extra back exit just in case

        } else if (floorNum === 2) {
            // Office Layout - Cubicles/Corridors
            // Central Corridor area is y=10 to y=12

            // Walls defining the corridor (Top and Bottom)
            this.addToWalls(2, 9, w - 4, 1);
            this.addToWalls(2, 13, w - 4, 1);

            // Top Rooms (Cubicles)
            for (let i = 4; i < w - 4; i += 6) {
                this.addToWalls(i, 2, 1, 6); // Vertical dividers
                this.addToWalls(i, 8, 4, 1); // Front of cubicle (leaves gap)
            }

            // Bottom Rooms (Meeting Rooms)
            this.addToWalls(w / 3, 15, 1, h - 15);
            this.addToWalls(2 * w / 3, 15, 1, h - 15);

            this.exits = [{ x: 1, y: 11 }, { x: w - 2, y: 11 }]; // Exits at ends of corridor
            // Users are now managed by server

        } else {
            // Labs - Complex rooms with hazardous equipment
            const midY = Math.floor(h / 2);

            // Vertical Hallways with GAPS (Doors)
            // Left Wall
            this.addToWalls(10, 0, 1, midY - 2);
            this.addToWalls(10, midY + 2, 1, h - (midY + 2));

            // Right Wall
            this.addToWalls(w - 10, 0, 1, midY - 2);
            this.addToWalls(w - 10, midY + 2, 1, h - (midY + 2));

            // Horizontal access
            this.addToWalls(0, midY, 8, 1);
            this.addToWalls(w - 8, midY, 8, 1);

            // Central Lab tables
            this.addToWalls(15, 6, w - 30, 2);
            this.addToWalls(15, h - 8, w - 30, 2);

            this.exits = [{ x: w - 2, y: 2 }, { x: 1, y: h - 3 }, { x: Math.floor(w / 2), y: 1 }];
            // Users are now managed by server
        }

        this.recalculate();
    }

    addToWalls(x, y, w, h) {
        for (let i = 0; i < w; i++) {
            for (let j = 0; j < h; j++) {
                this.walls.push({ x: Math.floor(x + i), y: Math.floor(y + j) });
            }
        }
    }

    spawnUsers(count) {
        let attempts = 0;
        while (this.users.length < count && attempts < 100) {
            const x = Math.floor(Math.random() * (this.width - 2)) + 1;
            const y = Math.floor(Math.random() * (this.height - 2)) + 1;
            if (!this.isWall(x, y) && !this.users.some(u => u.x === x && u.y === y)) {
                this.users.push({ x, y, path: [] });
            }
            attempts++;
        }
    }

    // Spawn users logic removed, handled by manual placement via socket
    handleClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = Math.floor((e.clientX - rect.left) / this.gridSize);
        const y = Math.floor((e.clientY - rect.top) / this.gridSize);

        this.lastClick = { x, y }; // Save for calibration

        if (this.mode === 'fire') {
            if (this.isOnline) {
                this.socket.emit('toggleFire', { x, y, floor: this.currentFloor });
            } else {
                // Offline Fire Toggle
                const existingIdx = this.fireLocations.findIndex(f => f.x === x && f.y === y && f.floor === this.currentFloor);
                if (existingIdx >= 0) {
                    this.fireLocations.splice(existingIdx, 1);
                } else {
                    this.fireLocations.push({ x, y, floor: this.currentFloor });
                }
                this.updateStatus(this.fireLocations.some(f => f.floor === this.currentFloor));
                this.recalculate();
            }
        } else {
            if (!this.isWall(x, y)) {
                if (this.isOnline) {
                    this.socket.emit('updateUser', { x, y, floor: this.currentFloor, role: this.role });
                } else {
                    // Offline Mode Logic
                    if (this.role === 'firefighter') {
                        // Firefighters: Toggle (Add multiple)
                        const existingIdx = this.users.findIndex(u => u.x === x && u.y === y && u.floor === this.currentFloor);
                        if (existingIdx >= 0) {
                            this.users.splice(existingIdx, 1);
                        } else {
                            // Mix of behaviors: 50% Rescue, 50% Evacuate
                            const action = Math.random() > 0.5 ? 'rescue' : 'evacuate';
                            this.users.push({
                                x, y,
                                floor: this.currentFloor,
                                path: [],
                                role: 'firefighter',
                                ffAction: action,
                                id: `ff_${Date.now()}_${Math.random()}`
                            });
                        }
                    } else {
                        // Civilian: Single User Movement (Clear other civilians, keep firefighters)
                        this.users = this.users.filter(u => u.role === 'firefighter'); // Keep firefighters
                        this.users.push({
                            x: x,
                            y: y,
                            floor: this.currentFloor,
                            path: [],
                            role: 'civilian',
                            ffAction: 'evacuate', // Civilians always evacuate
                            id: 'me'
                        });
                        this.myId = 'me';
                    }
                    this.recalculate();
                }
            }
        }
    }

    updateStatus(isDanger) {
        if (isDanger) {
            this.statusPanel.classList.add('danger');
            this.statusText.textContent = "EMERGENCY: EVACUATE";
            this.overlayMsg.textContent = "Calculating safest route...";
        } else {
            this.statusPanel.classList.remove('danger');
            this.statusText.textContent = "ALL CLEAR";
        }
    }

    isWall(x, y) {
        return this.walls.some(w => w.x === x && w.y === y);
    }

    recalculate() {
        // Removed early return optimization to ensure paths update for all users
        console.log(`Recalculating paths for ${this.users.length} users...`);

        this.users.forEach(user => {
            const action = user.ffAction || (user.role === 'firefighter' ? 'rescue' : 'evacuate');
            user.path = this.findPath(user.x, user.y, user.role, action);
            console.log(`User ${user.id} (${user.role}-${action}): Path length ${user.path.length}`);

            // Voice Navigation for ME
            if (user.id === this.myId && user.path.length > 0) {
                const directions = this.getDirections(user.path);
                if (directions.length > 0) {
                    this.speak(directions[0]);
                } else if (user.path.length <= 1) {
                    if (user.role === 'firefighter' && action === 'rescue') {
                        this.speak("You have reached the fire");
                    } else {
                        this.speak("You have reached the exit");
                    }
                }
            }
        });
    }

    getDirections(path) {
        if (path.length < 2) return [];
        // Basic direction logic (Simplified)
        return ["Go forward"];
    }

    speak(text) {
        if ('speechSynthesis' in window) {
            if (this.lastInstruction === text && Date.now() - this.lastSpeakTime < 5000) return;
            this.lastInstruction = text;
            this.lastSpeakTime = Date.now();
            const utterance = new SpeechSynthesisUtterance(text);
            window.speechSynthesis.speak(utterance);
        }
    }

    findPath(startX, startY, role = 'civilian', ffAction = 'evacuate') {
        // Dijkstra's Algorithm for Weighted Pathfinding

        let targets = [];
        if (role === 'firefighter' && ffAction === 'rescue') {
            // Firefighters ON DUTY go TO the fire
            targets = this.fireLocations.filter(f => f.floor === this.currentFloor);

            // Fallback: If no fire, Firefighters evacuate (or patrol) to ensure path visibility
            if (targets.length === 0) {
                targets = this.exits;
            }
        } else {
            // Civilians AND Evacuating Firefighters go TO the exits
            targets = this.exits;
        }

        let startNode = { x: startX, y: startY, cost: 0, parent: null };
        let openSet = [startNode];
        let visited = new Map(); // key -> minCost
        let nearestTarget = null;

        // Cost function
        const getCost = (x, y) => {
            if (this.isWall(x, y)) return Infinity; // Walls are impassable

            let cost = 1; // Base movement cost (Safe)

            // Civilians and EVACUATING firefighters avoid fire
            const shouldAvoidFire = (role !== 'firefighter') || (role === 'firefighter' && ffAction === 'evacuate');

            if (this.fireLocations.length > 0 && shouldAvoidFire) {
                // Civilians avoid fire
                for (const fire of this.fireLocations) {
                    if (fire.floor !== this.currentFloor) continue;

                    const dist = Math.sqrt((x - fire.x) ** 2 + (y - fire.y) ** 2);
                    if (dist < 4) {
                        // Hazard Cost
                        cost += Math.floor((4.5 - dist) * 10);
                    }
                }
            }
            // Rescue Firefighters ignore fire cost

            return cost;
        };

        while (openSet.length > 0) {
            // Sort by cost
            openSet.sort((a, b) => a.cost - b.cost);
            let curr = openSet.shift();
            const key = `${curr.x},${curr.y}`;

            if (visited.has(key) && visited.get(key) <= curr.cost) continue;
            visited.set(key, curr.cost);

            // Check if target reached (fuzzy match for fire?)
            // Exits are exact points. Fires are points too.
            if (targets.some(t => t.x === curr.x && t.y === curr.y)) {
                nearestTarget = curr;
                break;
            }

            // Neighbors
            const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
            for (let d of dirs) {
                const nx = curr.x + d[0];
                const ny = curr.y + d[1];

                if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
                    const stepCost = getCost(nx, ny);

                    if (stepCost !== Infinity) {
                        const newCost = curr.cost + stepCost;
                        const nKey = `${nx},${ny}`;

                        if (!visited.has(nKey) || visited.get(nKey) > newCost) {
                            openSet.push({ x: nx, y: ny, cost: newCost, parent: curr });
                        }
                    }
                }
            }
        }

        // Reconstruct path
        const path = [];
        if (nearestTarget) {
            let curr = nearestTarget;
            while (curr) {
                path.unshift({ x: curr.x, y: curr.y });
                curr = curr.parent;
            }
        }
        return path;
    }

    draw() {
        const ctx = this.ctx;
        const gs = this.gridSize;

        // Clear
        ctx.fillStyle = '#141414';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw Map (Custom or Default)
        if (this.customMap) {
            ctx.drawImage(this.customMap, 0, 0, this.canvas.width, this.canvas.height);
            // Draw semi-transparent dark overlay so UI elements pop
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        } else {
            // Draw Grid (Subtle)
            ctx.strokeStyle = '#222';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let x = 0; x <= this.width; x++) { ctx.moveTo(x * gs, 0); ctx.lineTo(x * gs, this.canvas.height); }
            for (let y = 0; y <= this.height; y++) { ctx.moveTo(0, y * gs); ctx.lineTo(this.canvas.width, y * gs); }
            ctx.stroke();

            // Draw Walls
            ctx.fillStyle = '#444';
            this.walls.forEach(w => {
                ctx.shadowColor = 'transparent';
                ctx.fillRect(w.x * gs, w.y * gs, gs, gs);
                // 3D effect top highlight
                ctx.fillStyle = '#555';
                ctx.fillRect(w.x * gs, w.y * gs, gs, 4);
                ctx.fillStyle = '#444';
            });
        }


        // Draw Exits
        ctx.fillStyle = '#00ff9d';
        ctx.shadowColor = '#00ff9d';
        ctx.shadowBlur = 20;
        this.exits.forEach(e => {
            ctx.fillRect(e.x * gs, e.y * gs, gs, gs);
            // Text
            ctx.font = '10px Inter';
            ctx.fillStyle = '#000';
            ctx.fillText("EXIT", e.x * gs + 4, e.y * gs + gs / 2 + 3);
            ctx.fillStyle = '#00ff9d';
        });

        // Draw Fire & Hazard Zone
        if (this.fireLocations.length > 0) {
            const time = Date.now();

            this.fireLocations.forEach(fire => {
                if (fire.floor !== this.currentFloor) return; // FIX: Only draw fire on current floor

                // Hazard Zone
                ctx.beginPath();
                ctx.fillStyle = 'rgba(255, 51, 51, 0.2)';
                ctx.arc((fire.x + 0.5) * gs, (fire.y + 0.5) * gs, gs * 4, 0, Math.PI * 2);
                ctx.fill();

                // Fire Core
                ctx.shadowColor = '#ff3333';
                ctx.shadowBlur = 30;
                ctx.fillStyle = '#ff3333';
                ctx.beginPath();
                ctx.arc((fire.x + 0.5) * gs, (fire.y + 0.5) * gs, gs / 1.5, 0, Math.PI * 2);
                ctx.fill();

                // Pulse Animation
                const pulse = (time % 1000) / 1000;
                ctx.fillStyle = `rgba(255, 50, 50, ${1 - pulse})`;
                ctx.beginPath();
                ctx.arc((fire.x + 0.5) * gs, (fire.y + 0.5) * gs, gs * (0.5 + pulse), 0, Math.PI * 2);
                ctx.fill();
            });
        }

        // Draw Paths for all users
        this.users.forEach(user => {
            if (user.floor !== this.currentFloor) return; // FIX: Only draw paths for users on current floor
            if (user.path.length > 1) {
                // Determine path color based on intent
                const action = user.ffAction || (user.role === 'firefighter' ? 'rescue' : 'evacuate');

                // If action is rescue but no fire exists, we fell back to exit.
                // Let's check the target of the path? 
                // Simplest: If role is firefighter and action is rescue, RED.

                if (action === 'rescue' && user.role === 'firefighter') {
                    ctx.strokeStyle = '#ef4444'; // RED for Attack Path
                } else {
                    ctx.strokeStyle = '#00ff9d'; // GREEN for Evac Path
                }

                ctx.lineWidth = 4; // Thicker line for visibility
                ctx.lineJoin = 'round';
                ctx.shadowColor = ctx.strokeStyle;
                ctx.shadowBlur = 10;
                ctx.beginPath();
                ctx.moveTo((user.path[0].x + 0.5) * gs, (user.path[0].y + 0.5) * gs);
                for (let i = 1; i < user.path.length; i++) {
                    ctx.lineTo((user.path[i].x + 0.5) * gs, (user.path[i].y + 0.5) * gs);
                }
                ctx.stroke();
            }
        });

        // Draw All Users
        this.users.forEach(user => {
            if (user.floor !== this.currentFloor) return; // FIX: Only draw users on current floor
            ctx.shadowBlur = 20;

            // Highlight ME
            if (user.id === this.myId) {
                // Yellow ring for myself
                ctx.strokeStyle = '#ffff00';
                ctx.lineWidth = 2;
                ctx.strokeRect(user.x * gs, user.y * gs, gs, gs);

                if (user.role === 'firefighter') {
                    ctx.fillStyle = '#dc2626'; // Red for Firefighter ME
                } else {
                    ctx.fillStyle = '#3b82f6'; // Blue for Civilian ME
                }
            } else {
                if (user.role === 'firefighter') {
                    ctx.fillStyle = '#991b1b'; // Dark Red for Other Firefighters
                } else {
                    ctx.fillStyle = '#8b8b8b'; // Gray for others
                }
            }

            ctx.shadowColor = ctx.fillStyle;
            ctx.beginPath();
            ctx.arc((user.x + 0.5) * gs, (user.y + 0.5) * gs, gs / 2.5, 0, Math.PI * 2);
            ctx.fill();
        });

        ctx.shadowBlur = 0;
    }

    animate() {
        this.draw();
        requestAnimationFrame(() => this.animate());
    }
    unlockVoice() {
        if ('speechSynthesis' in window) {
            // Create a silent utterance to unlock the audio context if needed
            // Some browsers require user interaction before playing audio
            if (window.speechSynthesis.paused) {
                window.speechSynthesis.resume();
            }
        }
    }

    setupRealWorld() {
        // Real-World features (Map Upload & GPS) removed by user request
    }

    isInBounds(x, y) {
        return x >= 0 && x < this.width && y >= 0 && y < this.height;
    }
}

// Initialize
window.onload = () => {
    const app = new EvacuationSystem();
};