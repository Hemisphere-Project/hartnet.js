
const fs = require('fs');
const path = require('path');
const Netmask = require('netmask').Netmask;

// Conf
const presetPath = '/data/hartnet/presets';

// Load hartnet as libary
var hartnet = require('../hartnet.js');

const uplink = '10.0.0.0/16'    // 10.0.0.0/16
const upNet = new Netmask(uplink);

const downlink = '2.0.0.0/8'  // 2.0.0.0/8
const downNet = new Netmask(downlink);

// Enum for modes
const NONE = 0;
const RECORD = 1;
const PLAYBACK = 2;
const RELAY = 3;    

// State
var MODE = RELAY; // default mode
var PRESET = 0; // default preset
var PLAYTIME = 0; // default playback time

// Vars
var modeBuffer = [];
var modeStart = 0;
var modeIndex = 0;
var modeInterval = 0;

// Create recpath if not exists
if (!fs.existsSync(presetPath)) {
    fs.mkdirSync(presetPath, { recursive: true });
    console.log('Rec path created:', presetPath);
}
const backupPath = path.join(presetPath, 'backup');
if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true });
    console.log('Backup path created:', backupPath);
}

// Create new hartnet instance
//
var hub = new hartnet({
  name: "hartnet-bridge",
  log_level: "info",
  poll_interval: 10000,
  poll_to: downlink,
  errFunc: (err) => { console.warn('ERROR:', err); }
});

var RECEIVERS = [];
var SENDERS = {};


// Utils
function dataLog(data) {
    // log 10 first bytes, add 3 dots, and last 5 bytes
    // each values must be padded to 3 characters to be aligned
    return data.slice(0, 10).map((v) => v.toString().padStart(3)).join(' ') + ' ... ' + data.slice(-5).map((v) => v.toString().padStart(3)).join(' '); 
}

// Global 
function mode_switch(m, preset) {
    if (m == MODE && preset == PRESET) {
        // console.log('Already in mode:', m);
        return;
    }

    if (MODE == PLAYBACK) play_stop()
    else if (MODE == RECORD) rec_stop()
    else if (MODE == RELAY) relay_stop()

    modeStart = Date.now();
    modeBuffer = [];
    modeIndex = 0;

    PRESET = preset

    if (m == RECORD) rec_start();
    else if (m == PLAYBACK) play_start();
    else if (m == RELAY) relay_start();

    console.log('Mode switched to:', m);
}
function mode_data(universe, data) {

    if (universe == 0) {
        console.log('\t   SYS\tuniverse:', universe, '\tdata:', dataLog(data))
        
        // 512 enabled -> mode control
        if (data[511] == 0) return  // 512 at 0 -> do nothing, let current mode run

        if (data[510] == 0) mode_switch(RELAY);                                           // 511 at 0             -> RELAY mode
        else if (data[510] > 0 && data[510] < 100)   mode_switch(PLAYBACK, data[510]);    // 511 from 1 to 99     -> PLAYBACK mode
        else if (data[510] > 100 && data[510] < 200) mode_switch(RECORD, data[510]-100);      // 511 from 101 to 199  -> RECORD mode

        return;                                             // Universe 0 is reserved for mode control
    }

    if (MODE == PLAYBACK)   play_data(universe, data);
    if (MODE == RECORD)     rec_data(universe, data);
    if (MODE == RELAY)      relay_data(universe, data);
}

// Relay methods
function relay_start() {
    if (MODE == RELAY) return;
    MODE = RELAY;
    console.log('Relay started');
}
function relay_data(universe, data) {
    if (MODE != RELAY) return;
    if (SENDERS[universe]) 
        SENDERS[universe].forEach((sender) => {
            sender.send(data);
            // console.log('Forwarded data from universe', universe, 'to', sender.options.nickname + ' (' + sender.options.to + ')');
            console.log('\t-> FWD\tuniverse:', universe, '\tdata:', dataLog(data), '\tto:', sender.options.nickname + ' (' + sender.options.to + ')');
        })
    else {
        // console.log('No sender for universe:', universe);
    }
}
function relay_stop() {
    if (MODE != RELAY) return;
    MODE = NONE
    console.log('Relay stopped');
}

// Record methods
function rec_start() {
    if (MODE == RECORD) return;
    MODE = RECORD;
    console.log('Recording started for preset:', PRESET);
}
function rec_data(universe, data) {
    if (MODE != RECORD) return;
    let trame = {'time': Date.now()-modeStart, 'universe': universe, 'data': data};
    modeBuffer.push(trame);
    console.log('\t++ REC\tuniverse:', universe, '\tdata:', dataLog(data))
}
function rec_stop() {
    if (MODE != RECORD) return;
    MODE = NONE;

    // Record less than 1 second -> do not save
    if (Date.now()-modeStart < 1000) {
        console.log('Recording stopped, but less than 1 second, not saved');
        return;
    }

    // Save modeBuffer to file
    let recFilename = 'preset_' + PRESET + '.csv'
    let recFile = path.join(presetPath, recFilename);
    let recBackup = path.join(backupPath, recFilename)
    
    // Format modeBuffer to CSV, with columns: time, universe, data[0], data[1], ..., data[511]
    let dataLines = modeBuffer.map((trame) => {
        let dataLine = trame.data.map((v) => v.toString().padStart(4)).join(',');
        return trame.time.toString().padStart(8) + ',' + trame.universe.toString().padStart(4) + ',' + dataLine;
    }).join('\n');
    
    // If file exists, backup it, if backup exists, increment the backup number
    if (fs.existsSync(recFile)) {
        let backIndex = 0;
        do {
            backIndex = backIndex + 1 % 99;
            backupFile = recBackup + '-' + backIndex.toString().padStart(2, '0');
        }
        while (fs.existsSync(backupFile));
        fs.renameSync(recFile, backupFile);
        console.log('Backup file created:', backupFile);
    }

    // Write to file
    fs.writeFileSync(recFile, dataLines);

    console.log('Record saved to:', recFile);
}

// Playback methods
function play_start() {
    if (MODE == PLAYBACK) return;
    MODE = PLAYBACK;

    // Load modeBuffer from file
    let playFile = path.join(presetPath, 'preset_' + PRESET + '.csv');
    if (!fs.existsSync(playFile)) {
        console.log('Preset not found:', playFile);
        relay_start()
        return;
    }

    // Load buffer from csv
    let data = fs.readFileSync(playFile, 'utf8');
    let lines = data.split('\n');
    modeBuffer = lines.map((line) => {
        let values = line.split(',');
        let time = parseInt(values[0]);
        let universe = parseInt(values[1]);
        let data = values.slice(2).map((v) => parseInt(v));
        return {'time': time, 'universe': universe, 'data': data};
    }).filter((trame) => {
        return trame.time >= 0 && trame.universe > 0 && trame.universe < 16
    });

    if (modeInterval) clearInterval(modeInterval);
    modeInterval = setInterval(() => {

        // no data
        if (modeIndex >= modeBuffer.length) {
            mode_switch(RELAY);     
            return;
        }

        // time to play
        while (modeBuffer[modeIndex].time < Date.now()-modeStart) 
        {
            let trame = modeBuffer[modeIndex];
            let universe = trame.universe;
            let data = trame.data;
            
            if (SENDERS[universe]) 
                SENDERS[universe].forEach((sender) => {
                    sender.send(data);
                    console.log('\t=> PLAY\tuniverse:', universe, '\tdata:', dataLog(data), '\tto:', sender.options.nickname + ' (' + sender.options.to + ')');
                })
            
            modeIndex++;
            if (modeIndex >= modeBuffer.length) {
                modeIndex = 0;
                modeStart = Date.now(); // reset start time
                console.log('Playback looped');
            }
        }
    }, 25); // 40 fps
            
    console.log('Playback started for preset:', playFile);
}
function play_data(universe, data) {
    if (MODE != PLAYBACK) return;
}
function play_stop() {
    if (MODE != PLAYBACK) return;
    MODE = NONE;
    console.log('Playback stopped');
}

// Create receivers for universe 0-15
// Prepare senders, which will be populated when actually discovering devices
// Receivers on uplink will forward data to all downlink senders in the same portAddress
//
for (var i = 0; i < 16; i++) 
{
    let receiver = hub.newReceiver({ from: uplink, universe: i });
    receiver.on('data', (data) => { 
        mode_data(receiver.portAddress, data);  // on receive: forward to mode processor
    })  
    RECEIVERS.push(receiver);
}

// Watch hub for new remote inputs
//
hub.on('remote-input-new', (node, portnumber) => {
    // check if node.ip is in downlink range
    if (!downNet.contains(node.ip)) {
        console.log('-- Node not in downlink range, ignoring:', node.ip);
        return
    }
    console.log('++ Remote input discovered:', node.ip, node.shortName);
    let port = node.inPorts[portnumber];

    if (!SENDERS[port.portAddress]) SENDERS[port.portAddress] = []
    let sender = hub.newSender({
        to: node.ip,
        broadcast: false,
        universe: port.universe,
        net: port.net,
        subnet: port.subnet,
        base_refresh_interval: 0,   // do not auto refresh, only send when data received from uplink
        nickname: node.shortName,
    });
    SENDERS[port.portAddress].push(sender);
});



