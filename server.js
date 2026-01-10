const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from current directory
app.use(express.static(__dirname));

// Application State
let users = {}; // userId -> { x, y, id, color }
let fireLocations = []; // Array of {x, y}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Send initial state to the new user
    socket.emit('init', {
        id: socket.id,
        users: Object.values(users),
        fireLocations: fireLocations
    });

    // Handle user movement / placement
    socket.on('updateUser', (data) => {
        // data = { x, y, floor }
        users[socket.id] = {
            id: socket.id,
            x: data.x,
            y: data.y,
            floor: data.floor || 1 // Default to floor 1 if missing
        };
        // Broadcast updated user list to ALL clients
        io.emit('stateUpdate', {
            users: Object.values(users),
            fireLocations: fireLocations
        });
    });

    // Handle Fire Updates
    socket.on('toggleFire', (data) => {
        // data = { x, y, floor }
        const floor = data.floor || 1;
        const existingIdx = fireLocations.findIndex(f => f.x === data.x && f.y === data.y && f.floor === floor);

        if (existingIdx >= 0) {
            fireLocations.splice(existingIdx, 1);
        } else {
            fireLocations.push({ x: data.x, y: data.y, floor: floor });
        }

        io.emit('stateUpdate', {
            users: Object.values(users),
            fireLocations: fireLocations
        });
    });

    // Handle Clear Fire
    socket.on('clearFire', (data) => {
        const floor = data.floor || 1;
        // Filter out fires from the specific floor
        fireLocations = fireLocations.filter(f => f.floor !== floor);

        io.emit('stateUpdate', {
            users: Object.values(users),
            fireLocations: fireLocations
        });
    });

    // Handle Disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete users[socket.id];
        io.emit('stateUpdate', {
            users: Object.values(users),
            fireLocations: fireLocations
        });
    });
});

const os = require('os');

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIp();
    console.log(`Server running! Access it here:`);
    console.log(`- Local:   http://localhost:${PORT}`);
    console.log(`- Network: http://${ip}:${PORT}  <-- Open this on your phone`);
});
