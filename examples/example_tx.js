
// Load hartnet as libary
var hartnet = require('../hartnet.js');

// Create new hartnet instance
var artnet = new hartnet.hartnet({
  log: {
    name: "hartnet-tx",
    level: "trace"
  }
});

// Create new Sender instance
var sender = artnet.newSender({
  to: '192.168.1.0',
  broadcast: true,
  universe: 0,
  subnet: 0,
  net: 0,
});

// Set Channels
sender.setChannel(511, 255);
sender.setChannel(255, 128);

// Fill Channels
sender.fillChannels(1, 20, 250);

// Prepare Channel 26+27 after 10 s and send next secondly
setTimeout(function() {
  sender.prepChannel(25, 255);
  sender.prepChannel(26, 255);
  sender.transmit();
}, 10000);

// Stop sender after 5 seconds
setTimeout(function() {
  sender.stop();
}, 50000);
