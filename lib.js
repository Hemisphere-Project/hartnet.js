"use strict";
/* eslint-env node, mocha */
var dgram = require("dgram");
var EventEmitter = require("events");
var jspack = require("jspack").jspack;
const os = require("os");
const Netmask = require("netmask").Netmask;
// Require Logging
const LoggingBase = require('@hibas123/nodelogging').LoggingBase;
// Init Logger
let log;

const swap16 = (val) => {
  return ((val & 0xff) << 8) | ((val >> 8) & 0xff);
};

// ArtDMX Header for jspack
var ArtDmxHeaderFormat = "!7sBHHBBBBH";
// ArtDMX Payload for jspack
var ArtDmxPayloadFormat = "512B";

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
    this.sName = options.sName || 'dmxnet'; // Shortname
    this.lName = options.lName || 'dmxnet - OpenSource ArtNet Transceiver';
    this.logOptions = options.log || {name: 'dmxnet'};
    // Set log levels
    if (this.verbose > 0) {
      // ToDo: Set Log Level
      if (this.verbose > 1) {
        // ToDo: Set Log Level Debug
      }
    } else {
      // ToDo: Set Log Level
    }
    // Create Logger
    log = new LoggingBase(this.logOptions);
    // Log started information
    this.logger.info('started with options: %o', options);

    // Log started information
    this.logger.info("started with options: %o", options);

    // Get all network interfaces
    this.interfaces = os.networkInterfaces();
    this.ip4 = [];
    this.ip6 = [];
    Object.keys(this.interfaces).forEach((key) => {
      this.interfaces[key].forEach((val) => {
        if (val.family === "IPv4") {
          var netmask = new Netmask(val.cidr);
          if (
            this.hosts.length === 0 ||
            this.hosts.indexOf(val.address) !== -1
          ) {
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
    this.logger.verbose("Interfaces: %o", this.ip4);

    this.artPollReplyCount = 0;
    this.controllers = [];
    this.nodes = [];
    this.senders = [];
    this.receivers = [];
    this.receiversSubUni = {};
    this.last_poll;

    if (!Number.isInteger(this.port))
      this.handleError(new Error("Invalid Port"));
    this.listener4 = dgram.createSocket({
      type: "udp4",
      reuseAddr: true,
    });

    this.listener4.on("error", function (err) {
      this.handleError(new Error("Socket error: ", err));
    });

    this.listener4.on("message", (msg, rinfo) => {
      dataParser(msg, rinfo, this);
    });

    this.listener4.bind(this.port);
    this.logger.info("Listening on port " + this.port);

    this.socket = dgram.createSocket("udp4");
    this.socket.bind(() => {
      this.socket.setBroadcast(true);
      this.socket_ready = true;
    });

    setInterval(() => {
      if (this.controllers) {
        this.logger.verbose(
          "Check controller alive, count " + this.controllers.length
        );
        for (var index = 0; index < this.controllers.length; index++) {
          if (
            new Date().getTime() -
              new Date(this.controllers[index].last_poll).getTime() >
            60000
          ) {
            this.controllers[index].alive = false;
          }
        }
      }
    }, 30000);
    return this;
  }

  handleError(err) {
    if (typeof this.errFunc === "function") {
      this.errFunc(err);
    } else {
      throw err;
    }
  }

  sync(callback) {
    this.syncListener = callback;

    this.listener4.on("message", (msg, rinfo) => {
      if (String(jspack.Unpack("!8s", msg)) !== "Art-Net\u0000") {
        return;
      }

      const opcode =
        parseInt(jspack.Unpack("B", msg, 8), 10) +
        parseInt(jspack.Unpack("B", msg, 9), 10) * 256;

      if (opcode === 0x5200) {
        // ArtNet Sync opcode
        this.logger.debug(
          `ArtNet Sync packet received from ${rinfo.address}:${rinfo.port}`
        );

        if (this.syncListener) {
          this.syncListener({
            ip: rinfo.address,
            port: rinfo.port,
            message: msg,
          });
        }
      }
    });
  }

  newSender(options) {
    var s = new sender(options, this);
    this.senders.push(s);
    this.ArtPollReply();
    return s;
  }

  newReceiver(options) {
    var r = new receiver(options, this);
    this.receivers.push(r);
    this.ArtPollReply();
    return r;
  }

  ArtPollReply() {
    this.logger.silly("Send ArtPollReply");
    // ArtPollReply logic unchanged
  }
}


// Export dmxnet
module.exports = {
  dmxnet,
};
