
// Load hartnet as libary
var hartnet = require('../hartnet.js');

const uplink = '192.168.1.1/24'    // 10.0.0.0/16
const downlink = '192.168.1.1/24'  // 2.0.0.0/8

// Create new hartnet instance
//
var hub = new hartnet({
  name: "hartnet-bridge",
  log_level: "debug",
  poll_interval: 3000,
  poll_to: downlink,
  errFunc: (err) => { console.warn('ERROR:', err); }
});

var RECEIVERS = [];
var SENDERS = {};

// Create receivers for universe 0-15
// Prepare senders, which will be populated when actually discovering devices
// Receivers will forward data to all senders in the same universe
//
for (var i = 0; i < 6; i++) 
{
    let receiver = hub.newReceiver({
        from: uplink,
        universe: i
    });
    
    // on receive: forward to all senders to the same universe
    receiver.on('data', (data) => {
        // console.log('Received data:', data);
        let u = receiver.options.universe;
        if (SENDERS[u]) 
            SENDERS[u].forEach((sender) => {
                sender.send(data);
                console.log('Forwarded data to universe ', u);
            })
        else console.log('No sender for universe:', u);
    }) 

    RECEIVERS.push(receiver);
}

// Watch hub for node-update
//
// hub.on('node-update', (node) => {
//     console.log('Node discovered:', node);
//     for(var key in node.inPorts) {
//         // console.log('  Port:', key, '->', node.inPorts[key]);
//         if (!SENDERS[node.inPorts[key].universe]) SENDERS[node.inPorts[key].universe] = []
//         let sender = hub.newSender({
//             to: node.inPorts[key].ip,
//             // broadcast: true,
//             universe: node.inPorts[key].universe,
//             net: node.inPorts[key].net,
//             subnet: node.inPorts[key].subnet
//         });
//         SENDERS[node.inPorts[key].universe].push(sender);
//     }
// });

