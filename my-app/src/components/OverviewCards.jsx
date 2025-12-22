// src/components/OverviewCards.jsx
import React from 'react';
import { Grid, Paper, Typography } from '@mui/material';

export default function OverviewCards({ totalPower, todayKWh, threshold }) {
  return (
    <Grid container spacing={2} className="app-grid">
      <Grid item xs={12} sm={4}>
        <Paper className="glass-card">
          <Typography variant="subtitle2">Total Power (W)</Typography>
          <Typography variant="h5" sx={{ mt: 1 }}>{totalPower?.toFixed(1) ?? '0.0'}</Typography>
        </Paper>
      </Grid>
      <Grid item xs={12} sm={4}>
        <Paper className="glass-card">
          <Typography variant="subtitle2">Today (kWh)</Typography>
          <Typography variant="h5" sx={{ mt: 1 }}>{(todayKWh ?? 0).toFixed(2)}</Typography>
        </Paper>
      </Grid>
      <Grid item xs={12} sm={4}>
        <Paper className="glass-card">
          <Typography variant="subtitle2">Threshold (W)</Typography>
          <Typography variant="h5" sx={{ mt: 1 }}>{threshold}</Typography>
        </Paper>
      </Grid>
    </Grid>
  );
}
