'use strict';

module.exports = {
  async getDevices({ homey }) {
    return homey.app.getControllableDevices();
  },
  async getConfig({ homey }) {
    return homey.app.getConfig();
  },
  async setConfig({ homey, body }) {
    return homey.app.saveConfig(body);
  },
  async applyNow({ homey }) {
    return homey.app.applyNow();
  },
  async resumeDevice({ homey, body }) {
    return homey.app.resumeDevice(body.deviceId);
  },
  async resumeAll({ homey }) {
    return homey.app.resumeAll();
  },
  async simulateGroup({ homey, body }) {
    return homey.app.simulateGroup(body.groupId);
  },
  async stopSimulation({ homey }) {
    return homey.app.stopSimulation();
  },
  async getSimulationStatus({ homey }) {
    return homey.app.getSimulationStatus();
  },
  async getStatus({ homey }) {
    return homey.app.getStatus();
  },
  async getSensors({ homey }) {
    return homey.app.getLightSensors();
  },
  async showTestColor({ homey, body }) {
    return homey.app.showTestColor(body.groupId, body.kelvin);
  },
  async stopTestColor({ homey }) {
    return homey.app.stopTestColor();
  },
  async getHistory({ homey, query }) {
    return homey.app.getHistory(query.groupId, query.range);
  },
};
