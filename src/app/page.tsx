'use client'

import { TopBar } from '@/components/dashboard/TopBar'
import { ScannerPanel } from '@/components/scanner/ScannerPanel'
import { ChartPanel } from '@/components/chart/ChartPanel'
import { CompanionPanel } from '@/components/companion/CompanionPanel'
import { PositionTracker } from '@/components/positions/PositionTracker'

export default function Dashboard() {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <TopBar />
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left: Scanner */}
        <div className="w-72 flex-shrink-0 overflow-hidden">
          <ScannerPanel />
        </div>

        {/* Centre: Chart */}
        <div className="flex-1 overflow-hidden">
          <ChartPanel />
        </div>

        {/* Right: Companion */}
        <div className="w-80 flex-shrink-0 overflow-hidden">
          <CompanionPanel />
        </div>
      </div>

      {/* Bottom: Position Tracker */}
      <PositionTracker />
    </div>
  )
}
