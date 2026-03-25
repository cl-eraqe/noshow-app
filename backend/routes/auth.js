const express = require('express');
const router = express.Router();

router.post('/login', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN is required' });

  const staffPin      = process.env.STAFF_PIN;
  const supervisorPin = process.env.SUPERVISOR_PIN;

  if (!staffPin || !supervisorPin) {
    return res.status(500).json({ error: 'Server PIN configuration missing' });
  }

  if (pin === supervisorPin) return res.json({ role: 'supervisor' });
  if (pin === staffPin)      return res.json({ role: 'staff' });

  return res.status(401).json({ error: 'Invalid PIN' });
});

module.exports = router;
