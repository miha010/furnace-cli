cmd = require("../actions/ignite")

exports.command = 'ignite'
exports.desc = 'Initialize a new Furnace instance'
exports.builder = {}
exports.handler = async (argv) => {
  await cmd();
}