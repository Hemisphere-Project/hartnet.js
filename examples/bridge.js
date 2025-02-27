
// Load hartnet as libary
var hartnet = require('../hartnet.js');
const Netmask = require('netmask').Netmask;

const uplink = '10.0.0.0/16'    // 10.0.0.0/16
const upNet = new Netmask(uplink);

const downlink = '2.0.0.0/8'  // 2.0.0.0/8
const downNet = new Netmask(downlink);

// Create new hartnet instance
//
var hub = new hartnet({
  name: "hartnet-bridge",
  log_level: "info",
  poll_interval: 3000,
  poll_to: downlink,
  errFunc: (err) => { console.warn('ERROR:', err); }
});

var RECEIVERS = [];
var SENDERS = {};

// Create receivers for universe 0-15
// Prepare senders, which will be populated when actually discovering devices
// Receivers on uplink will forward data to all downlink senders in the same portAddress
//
for (var i = 0; i < 16; i++) 
{
    let receiver = hub.newReceiver({
        from: uplink,
        universe: i
    });
    
    // on receive: forward to all senders to the same universe
    receiver.on('data', (data) => {
        // console.log('Received data:', data);
        let u = receiver.portAddress;
        if (SENDERS[u]) 
            SENDERS[u].forEach((sender) => {
                sender.send(data);
                // console.log('Forwarded data to universe ', u);
            })
        else {
            // console.log('No sender for universe:', u);
        }
    }) 

    RECEIVERS.push(receiver);
}

// Watch hub for new remote inputs
//
hub.on('remote-input-new', (node, portnumber) => {
    // console.log('--- Remote input discovered:', node.ip );
    // check if node.ip is in downlink range
    if (!downNet.contains(node.ip)) {
        console.log('Node not in downlink range:', node.ip);
        return
    }
    let port = node.inPorts[portnumber];

    if (!SENDERS[port.portAddress]) SENDERS[port.portAddress] = []
    let sender = hub.newSender({
        to: node.ip,
        broadcast: false,
        universe: port.universe,
        net: port.net,
        subnet: port.subnet,
        base_refresh_interval: 0,
    });
    SENDERS[port.portAddress].push(sender);
});

