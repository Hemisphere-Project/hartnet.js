
// Load hartnet as libary
var hartnet = require('../hartnet.js');

const uplink = '10.2.0.0/16'    // 10.0.0.0/16
const downlink = '10.2.0.0/16'  // 2.0.0.0/8

// Create new hartnet instance
//
var hub = new hartnet({
  name: "hartnet-bridge",
  log_level: "trace",
  poll_interval: 3000,
  poll_to: downlink
});

var RECEIVERS = [];
var SENDERS = [];

// Create receivers for universe 0-15
// Prepare senders, which will be populated when actually discovering devices
// Receivers will forward data to all senders in the same universe
//
for (var i = 0; i < 1; i++) 
{
    let receiver = hub.newReceiver({
        from: uplink,
        universe: i
    });
    
    SENDERS.push([])
    RECEIVERS.push(receiver);

    // on receive: forward to all senders to the same universe
    receiver.on('data', (data) => {
        for (var s of SENDERS[i]) s.send(data);
    }) 
}

// Watch hub for node-update
//
hub.on('node-update', (node) => {
    console.log('Node update:');
    for(var key in node.inPorts) {
        console.log('  Port:', key, '->', node.inPorts[key]);
    }
});

