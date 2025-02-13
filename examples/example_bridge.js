
// Load hartnet as libary
var hartnet = require('../hartnet.js');

// Create new hartnet instance
var hub = new hartnet({
  log: {
    name: "hartnet-bridge",
    level: "debug"
  },
  poll_interval: 3000,
  poll_to: '10.2.0.0/16'
});

var RECEIVERS = [];
var SENDERS = [];

// Create receivers for universe 0-15
// Prepare senders, which will be populated when actually discovering devices
// Receivers will forward data to all senders in the same universe
//
for (var i = 0; i < 16; i++) 
{
    
    let receiver = hub.newReceiver({
        from: '10.2.0.0/16',
        universe: i
    });
    
    SENDERS.push([])
    RECEIVERS.push(receiver);

    // on receive: forward to all senders to the same universe
    receiver.on('data', (data) => {
        for (var s of SENDERS[i]) s.send(data);
    }) 
}


