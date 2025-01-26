// Description: Library for dmxnet
//

var dgram = require('dgram');
var EventEmitter = require('events');
var jspack = require('jspack').jspack;
const os = require('os');
const Netmask = require('netmask').Netmask;
const LoggingBase = require('@hibas123/nodelogging').LoggingBase;

const swap16 = (val) => { return ((val & 0xFF) << 8) | ((val >> 8) & 0xFF); };

var ArtDmxHeaderFormat = '!7sBHHBBBBH';   // ArtDMX Header (jspack)
var ArtDmxPayloadFormat = '512B';         // ArtDMX Payload (jspack)

/** Class representing the core dmxnet structure */
class dmxnet {
  /**
   * Creates a new dmxnet instance
   *
   * @param {object} options - Options for the whole instance
   */
  constructor(options = {}) {
    // Parse all options and set defaults
    this.oem = options.oem || 0x2908; // OEM code hex
    this.esta = options.esta || 0x0000; // ESTA code hex
    this.port = options.listen || 6454; // Port listening for incoming data
    this.hosts = options.hosts || []; // Array of IPs to listen for ArtPoll
    this.sName = options.sName || 'dmxnet'; // Shortname
    this.lName = options.lName || 'dmxnet - OpenSource ArtNet Transceiver'; // Longname
    this.logOptions = options.log || {name: 'dmxnet', files: false, console: true, level: 'info'};

    // Create Logger
    this.logger = new LoggingBase(this.logOptions);
    this.logger.debug('DMXnet started: ', options);

    // error function to call on error to avoid unhandled exeptions e.g. in Node-RED
    this.errFunc = typeof options.errFunc === 'function' ?  options.errFunc : undefined;

    // Get all network interfaces
    this.interfaces = os.networkInterfaces();
    this.ip4 = [];
    this.ip6 = [];

    // Iterate over interfaces and insert sorted IPs
    Object.keys(this.interfaces).forEach((key) => {
      this.interfaces[key].forEach((val) => {
        if (val.family === 'IPv4') {
          var netmask = new Netmask(val.cidr);
          if (this.hosts.length === 0 || (this.hosts.indexOf(val.address) !== -1)) {
            this.ip4.push({
              ip: val.address,
              netmask: val.netmask,
              mac: val.mac,
              broadcast: netmask.broadcast,
            });
          }
        }
      });
    });

    this.logger.debug('Interfaces: ', this.ip4);
    // init artPollReplyCount
    this.artPollReplyCount = 0;
    // Array containing reference to foreign controllers
    this.controllers = [];
    // Array containing reference to foreign node's
    this.nodes = [];
    // Array containing reference to senders
    this.senders = [];
    // Array containing reference to receiver objects
    this.receivers = [];
    // Object containing reference to receivers by SubnetUniverseNet
    this.receiversByPortAddress = {};
    // Timestamp of last Art-Poll send
    this.last_poll;
    // Create listener for incoming data
    if (!Number.isInteger(this.port)) this.handleError(new Error('Invalid Port'));
    this.listener4 = dgram.createSocket({
      type: 'udp4',
      reuseAddr: true,
    });

    // ToDo: IPv6
    // ToDo: Multicast
    // Catch Socket errors
    this.listener4.on('error', function (err) {
      this.handleError(new Error('Socket error: ', err));
    });
    // Register listening object
    this.listener4.on('message', (msg, rinfo) => {
      this.dataParser(msg, rinfo);
    });
    // Start listening
    this.listener4.bind(this.port);
    this.logger.debug('Listening on port ' + this.port);
    // Open Socket for sending broadcast data
    this.socket = dgram.createSocket('udp4');
    this.socket.bind(() => {
      this.socket.setBroadcast(true);
      this.socket_ready = true;
    });
    // Periodically check Controllers
    setInterval(() => {
      if (this.controllers) {
        this.logger.debug('Check controller alive, count ' + this.controllers.length);
        for (var index = 0; index < this.controllers.length; index++) {
          if ((new Date().getTime() - new Date(this.controllers[index].last_poll).getTime()) > 60000) {
            this.controllers[index].alive = false;
          }
        }
      }
    }, 30000);
    return this;
  }

  // Parser & receiver
  /**
   * @param {Buffer} msg - Message buffer to parse
   * @param {dgram.RemoteInfo} rinfo - Remote info
   */
  dataParser(msg, rinfo) 
  {
    var logMsg = `-> UDP from ${rinfo.address}:${rinfo.port}`
    if (rinfo.size < 10) {
      this.logger.debug(logMsg, '\t = Payload to short');
      return;
    }
    
    // Check first 8 bytes for the "Art-Net" - String
    if (String(jspack.Unpack('!8s', msg)) !== 'Art-Net\u0000') {
      this.logger.debug(logMsg, '\t = Invalid header');
      return;
    }
    var opcode = parseInt(jspack.Unpack('B', msg, 8), 10);
    opcode += parseInt(jspack.Unpack('B', msg, 9), 10) * 256;
    if (!opcode || opcode === 0) {
      this.logger.debug(logMsg, '\t = Invalid OpCode');
      return;
    }

    switch (opcode) {
      // ArtDmx
      //
      case 0x5000:

        var p_address = parseInt(jspack.Unpack('B', msg, 14), 10);
        var data = [];
        for (var ch = 1; ch <= msg.length - 18; ch++) {
          data.push(msg.readUInt8(ch + 17, true));
        }
        this.logger.debug('-> ArtDMX frame / univ.', p_address, '/', data.length, 'ch. /', rinfo.address + ':' + rinfo.port); 
        if (this.receiversByPortAddress[p_address]) this.receiversByPortAddress[p_address].receive(data);
        break;
      
      // ArtPoll
      //
      case 0x2000:
        if (rinfo.size < 14) {
          this.logger.debug(logMsg, '\t = ArtPoll too small');
          return;
        }
        // Parse Protocol version
        var proto = parseInt(jspack.Unpack('B', msg, 10), 10);
        proto += parseInt(jspack.Unpack('B', msg, 11), 10) * 256;
        if (!proto || proto < 14) {
          this.logger.debug(logMsg, '\t = invalid OpCode');
          return;
        }
        this.logger.debug('-> ArtPoll');
        // Parse TalkToMe
        var ctrl = {
          ip: rinfo.address,
          family: rinfo.family,
          last_poll: Date(),
          alive: true,
        };
        var ttm_raw = parseInt(jspack.Unpack('B', msg, 12), 10);
        ctrl.diagnostic_unicast = ((ttm_raw & 0b00001000) > 0);
        ctrl.diagnostic_enable = ((ttm_raw & 0b00000100) > 0);
        ctrl.unilateral = ((ttm_raw & 0b00000010) > 0);
        // Priority
        ctrl.priority = parseInt(jspack.Unpack('B', msg, 13), 10);
        // Insert into controller's reference
        var done = false;
        for (var index = 0; index < this.controllers.length; ++index) {
          if (this.controllers[index].ip === rinfo.address) {
            done = true;
            this.controllers[index] = ctrl;
          }
        }
        if (done !== true) {
          this.controllers.push(ctrl);
        }
        this.ArtPollReply();
        // this.logger.debug('\tControllers: ', this.controllers);
        break;
      
      // ArtPollReply
      //
      case 0x2100:
        // ToDo
        // this.logger.debug('-> ArtPollReply');
        break;

      // N.C.
      //
      default:
        this.logger.debug(logMsg, '\t = OpCode not implemented');
    }
  }

  /**
   * function to handle the errors an throw them or lead to errFunc
   *
   * @param {object} err - The error to handle
   */
  handleError(err) {
    if (typeof this.errFunc === 'function') {
      // give the error to the function and back to the parent object
      this.errFunc(err);
    } else {
      // if none, trow as before
      throw err;
    }
  }

  /**
   * Returns a new sender instance
   *
   * @param {object} options - Options for the new sender
   * @returns {sender} - Instance of Sender
   */
  newSender(options) {
    var s = new sender(options, this);
    this.senders.push(s);
    this.ArtPollReply();
    return s;
  }

  /**
   * Returns a new receiver instance
   *
   * @param {object} options - Options for the new receiver
   * @returns {receiver} - Instance of Receiver
   */
  newReceiver(options) {
    var r = new receiver(options, this);
    this.receivers.push(r);
    this.ArtPollReply();
    return r;
  }

  /**
   * Builds and sends an ArtPollReply-Packet
   */
  ArtPollReply() {
    this.ip4.forEach((ip) => {
      // BindIndex handles all the different "instance".
      var bindIndex = 1;
      var ArtPollReplyFormat = '!7sBHBBBBHHBBHBBH18s64s64sH4B4B4B4B4B3HB6B4BBB';
      var netSwitch = 0x01;
      var subSwitch = 0x01;
      var status = 0b11010000;
      var stateString = '#0001 [' + ('000' + this.artPollReplyCount).slice(-4) + '] dmxnet ArtNet-Transceiver running';
      var sourceip = ip.ip;
      var broadcastip = ip.broadcast;

      // Send one packet for each sender
      this.senders.forEach((s) => {
        var portType = 0b01000000;
        var udppacket = Buffer.from(jspack.Pack(
          ArtPollReplyFormat,
          ['Art-Net', 0, 0x0021,
            // 4 bytes source ip + 2 bytes port
            sourceip.split('.')[0], sourceip.split('.')[1],
            sourceip.split('.')[2], sourceip.split('.')[3], this.port,
            // 2 bytes Firmware version, netSwitch, subSwitch, OEM-Code
            0x0001, s.net, s.subnet, this.oem,
            // Ubea, status1, 2 bytes ESTA
            0, status, swap16(this.esta),
            // short name (18), long name (63), stateString (63)
            this.sName.substring(0, 16), this.lName.substring(0, 63), stateString,
            // 2 bytes num ports, 4*portTypes
            1, portType, 0, 0, 0,
            // 4*goodInput, 4*goodOutput
            0b10000000, 0, 0, 0, 0, 0, 0, 0,
            // 4*SW IN, 4*SW OUT
            s.universe, 0, 0, 0, 0, 0, 0, 0,
            // 5* deprecated/spare, style
            0, 0, 0, 0x01,
            // MAC address
            parseInt(ip.mac.split(':')[0], 16),
            parseInt(ip.mac.split(':')[1], 16),
            parseInt(ip.mac.split(':')[2], 16),
            parseInt(ip.mac.split(':')[3], 16),
            parseInt(ip.mac.split(':')[4], 16),
            parseInt(ip.mac.split(':')[5], 16),
            // BindIP
            sourceip.split('.')[0], sourceip.split('.')[1],
            sourceip.split('.')[2], sourceip.split('.')[3],
            // BindIndex, Status2
            bindIndex, 0b00001110,
          ]));
        // Increase bindIndex
        bindIndex = (bindIndex + 1) % 256;
        // Send UDP
        var client = this.socket;
        client.send(udppacket, 0, udppacket.length, 6454, broadcastip,
          (err) => {
            if (err) this.handleError(err);
            this.logger.debug(`<- ArtPollReply (Sender ${s.net}.${s.subnet}.${s.universe})`);
          });
      });

      // Send one package for every receiver
      this.receivers.forEach((r) => {
        var portType = 0b10000000;
        var udppacket = Buffer.from(jspack.Pack(
          ArtPollReplyFormat,
          ['Art-Net', 0, 0x0021,
            // 4 bytes source ip + 2 bytes port
            sourceip.split('.')[0], sourceip.split('.')[1],
            sourceip.split('.')[2], sourceip.split('.')[3], this.port,
            // 2 bytes Firmware version, netSwitch, subSwitch, OEM-Code
            0x0001, r.net, r.subnet, this.oem,
            // Ubea, status1, 2 bytes ESTA
            0, status, swap16(this.esta),
            // short name (18), long name (63), stateString (63)
            this.sName.substring(0, 16), this.lName.substring(0, 63), stateString,
            // 2 bytes num ports, 4*portTypes
            1, portType, 0, 0, 0,
            // 4*goodInput, 4*goodOutput
            0, 0, 0, 0, 0b10000000, 0, 0, 0,
            // 4*SW IN, 4*SW OUT
            0, 0, 0, 0, r.universe, 0, 0, 0,
            // 5* deprecated/spare, style
            0, 0, 0, 0x01,
            // MAC address
            parseInt(ip.mac.split(':')[0], 16),
            parseInt(ip.mac.split(':')[1], 16),
            parseInt(ip.mac.split(':')[2], 16),
            parseInt(ip.mac.split(':')[3], 16),
            parseInt(ip.mac.split(':')[4], 16),
            parseInt(ip.mac.split(':')[5], 16),
            // BindIP
            sourceip.split('.')[0], sourceip.split('.')[1],
            sourceip.split('.')[2], sourceip.split('.')[3],
            // BindIndex, Status2
            bindIndex, 0b00001110,
          ]));

        // Increase bindIndex
        bindIndex = (bindIndex + 1) % 256;

        // Send UDP
        var client = this.socket;
        client.send(udppacket, 0, udppacket.length, 6454, broadcastip,
          (err) => {
            if (err) this.parent.handleError(err);
            this.logger.debug(`<- ArtPollReply (Receiver ${r.net}.${r.subnet}.${r.universe})`);
          });
      });

      if ((this.senders.length + this.receivers.length) < 1) {
        // No senders and receivers available, propagate as "empty"
        var udppacket = Buffer.from(jspack.Pack(
          ArtPollReplyFormat,
          ['Art-Net', 0, 0x0021,
            // 4 bytes source ip + 2 bytes port
            sourceip.split('.')[0], sourceip.split('.')[1],
            sourceip.split('.')[2], sourceip.split('.')[3], this.port,
            // 2 bytes Firmware version, netSwitch, subSwitch, OEM-Code
            0x0001, netSwitch, subSwitch, this.oem,
            // Ubea, status1, 2 bytes ESTA
            0, status, swap16(this.esta),
            // short name (18), long name (63), stateString (63)
            this.sName.substring(0, 16), this.lName.substring(0, 63), stateString,
            // 2 bytes num ports, 4*portTypes
            0, 0, 0, 0, 0,
            // 4*goodInput, 4*goodOutput
            0, 0, 0, 0, 0, 0, 0, 0,
            // 4*SW IN, 4*SW OUT
            0, 0, 0, 0, 0, 0, 0, 0,
            // 5* deprecated/spare, style
            0, 0, 0, 0x01,
            // MAC address
            parseInt(ip.mac.split(':')[0], 16),
            parseInt(ip.mac.split(':')[1], 16),
            parseInt(ip.mac.split(':')[2], 16),
            parseInt(ip.mac.split(':')[3], 16),
            parseInt(ip.mac.split(':')[4], 16),
            parseInt(ip.mac.split(':')[5], 16),
            // BindIP
            sourceip.split('.')[0], sourceip.split('.')[1],
            sourceip.split('.')[2], sourceip.split('.')[3],
            // BindIndex, Status2
            1, 0b00001110,
          ]));

        this.logger.debug('Packet content: ' + udppacket.toString('hex'));

        // Send UDP
        var client = this.socket;
        client.send(udppacket, 0, udppacket.length, 6454, broadcastip,
          (err) => {
            if (err) this.parent.handleError(err);
            this.logger.debug('<- ArtPollReply (Empty)');
          });
      }
    });
    this.artPollReplyCount = (this.artPollReplyCount + 1) % 10000;
  }
}

/**
 * Class representing a sender
 */
class sender {
  /**
   * Creates a new sender, usually called trough factory in dmxnet
   *
   * @param {object} opt - Options for the sender
   * @param {dmxnet} parent - Instance of the dmxnet parent
   */
  constructor(opt, parent) 
  {
    this.parent = parent;

    // set options
    var options = opt || {};
    this.net = options.net || 0;
    this.subnet = options.subnet || 0;
    this.universe = options.universe || 0;
    this.ip = options.ip || '255.255.255.255';
    this.port = options.port || 6454;
    this.base_refresh_interval = options.base_refresh_interval || 1000;

    // Calculate Net/Subnet/Universe
    this.subnet += this.universe >> 4;
    this.universe = this.universe & 0x0F;
    this.net += this.subnet >> 4;
    this.subnet = this.subnet & 0x0F;

    // Build Subnet/Universe/Net Int16
    this.port_address = ((this.subnet << 4) | (this.universe) << 8) | this.net;
    if (this.port_address > 32767) {
      this.handleError(new Error('Invalid Port Address: net * subnet * universe must be smaller than 32768'));
    }

    // Initialize values
    this.socket_ready = false;
    this.ArtDmxSeq = 1;
    this.values = new Array(512).fill(0);

    // Create Socket
    this.socket = dgram.createSocket('udp4');

    // Check IP and Broadcast
    if (isBroadcast(this.ip)) {
      this.socket.bind(() => {
        this.socket.setBroadcast(true);
        this.socket_ready = true;
      });
    } else {
      this.socket_ready = true;
    }
    
    this.parent.logger.debug('SENDER started with params: ', options);

    // Transmit first Frame
    this.transmit();

    // Send Frame every base_refresh_interval ms - even if no channel was changed
    if ( this.base_refresh_interval > 0 )
      this.interval = setInterval(() => {
        this.transmit();
      }, this.base_refresh_interval);
  }

  /**
   * Transmits the current values
   */
  transmit() {
    if (!this.socket_ready) return

    // Build packet: ID Int8[8], OpCode Int16 0x5000 (conv. to 0x0050),
    // ProtVer Int16, Sequence Int8, PhysicalPort Int8,
    // SubnetUniverseNet Int16, Length Int16
    var udppacket = Buffer.from(jspack.Pack(ArtDmxHeaderFormat +
      ArtDmxPayloadFormat,
      ['Art-Net', 0, 0x0050, 14, this.ArtDmxSeq, 0, this.port_address, this.net, 512].concat(this.values)));
    // Increase Sequence Counter
    this.ArtDmxSeq = (this.ArtDmxSeq + 1) % 256;

    this.parent.logger.debug('Packet content: ' + udppacket.toString('hex'));
    // Send UDP
    var client = this.socket;
    client.send(udppacket, 0, udppacket.length, this.port, this.ip,
      (err) => {
        if (err) this.parent.handleError(err);
        this.parent.logger.debug('ArtDMX frame sent to ' + this.ip + ':' + this.port);
      });
  }

  /**
   * Sets a single channel to a value and transmits the change
   *
   * @param {number} channel - channel (0-511)
   * @param {number} value - value (0-255)
   */
  setChannel(channel, value) {
    if ((channel > 511) || (channel < 0)) {
      this.handleError(new Error('Channel must be between 0 and 512'));
    }
    if ((value > 255) || (value < 0)) {
      this.handleError(new Error('Value must be between 0 and 255'));
    }
    this.values[channel] = value;
    this.transmit();
  }


  /**
   * Prepares a single channel (without transmitting)
   *
   * @param {number} channel - channel (0-511)
   * @param {number} value - value (0-255)
   */
  prepChannel(channel, value) {
    if ((channel > 511) || (channel < 0)) {
      this.handleError(new Error('Channel must be between 0 and 512'));
    }
    if ((value > 255) || (value < 0)) {
      this.handleError(new Error('Value must be between 0 and 255'));
    }
    this.values[channel] = value;
  }

  /**
   * Fills channel block with a value and transmits the change
   *
   * @param {number} start - start of the block
   * @param {number} stop - end of the block (inclusive)
   * @param {number} value - value
   */
  fillChannels(start, stop, value) {
    if ((start > 511) || (start < 0)) {
      this.handleError(new Error('Channel must be between 0 and 512'));
    }
    if ((stop > 511) || (stop < 0)) {
      this.handleError(new Error('Channel must be between 0 and 512'));
    }
    if ((value > 255) || (value < 0)) {
      this.handleError(new Error('Value must be between 0 and 255'));
    }
    for (var i = start; i <= stop; i++) {
      this.values[i] = value;
    }
    this.transmit();
  }

  /**
   * Resets all channels to zero and Transmits
   */
  blackout() {
    this.values.fill(0);
    this.transmit();
  }

  /**
   * Stops the sender and destroys it
   */
  stop() {
    clearInterval(this.interval);
    this.parent.senders = this.parent.senders.filter((value) => value !== this);
    this.socket.close();
  }
}


// ToDo: Improve method
/**
 * Checks if IPv4 address given is a broadcast address - only used internally
 *
 * @param {string} ipaddress - IP address to check
 * @returns {boolean} - result, true: broadcast
 */
function isBroadcast(ipaddress) {
  var oct = ipaddress.split('.');
  if (oct.length !== 4) throw new Error('Wrong IPv4 lenght');
  for (var i = 0; i < 4; i++)
    if ((parseInt(oct[i], 10) > 255) || (parseInt(oct[i], 10) < 0))
      throw new Error('Invalid IP (Octet ' + (i + 1) + ')');
  if (oct[3] === '255') return true;
  return false;
}

/**
 *  Object representing a receiver-instance
 */
class receiver extends EventEmitter {
  /**
   * Creates a new receiver, usually called trough factory in dmxnet
   *
   * @param {object} opt - Options for the receiver
   * @param {dmxnet} parent - Instance of the dmxnet parent
   */
  constructor(opt, parent) {
    super();
    // save parent object
    this.parent = parent;

    // set options
    var options = opt || {};
    this.net = options.net || 0;
    this.subnet = options.subnet || 0;
    this.universe = options.universe || 0;

    // Calculate Net/Subnet/Universe
    this.subnet += this.universe >> 4;
    this.universe = this.universe & 0x0F;
    this.net += this.subnet >> 4;
    this.subnet = this.subnet & 0x0F;

    // Build Subnet/Universe/Net Int16
    this.port_address = ((this.subnet << 4) | (this.universe) << 8) | this.net;
    if (this.port_address > 32767) {
      this.handleError(new Error('Invalid Port Address: net * subnet * universe must be smaller than 32768'));
    }
    parent.receiversByPortAddress[this.port_address] = this;

    // Initialize values
    this.values = new Array(512).fill(0);
    
    this.parent.logger.debug('RECEIVER started: ', options, this.port_address );
  }

  /**
   * Handles received data
   *
   * @param {Array} data - Data from received ArtDMX
   */
  receive(data) {
    this.values = data;
    this.emit('data', data);
  }
}

// Export dmxnet
module.exports = {
  dmxnet,
};
