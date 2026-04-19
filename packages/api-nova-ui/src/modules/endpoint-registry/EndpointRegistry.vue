<template>
  <div class="endpoint-registry">
    <div class="page-header">
      <div>
        <h1>{{ pageTitle }}</h1>
        <p class="muted">
          {{ activeSubtitle }}
        </p>
      </div>
      <div class="header-actions">
        <el-popover
          v-if="currentSurface === 'governance'"
          placement="bottom-end"
          :width="420"
          trigger="click"
        >
          <template #reference>
            <el-button
              circle
              plain
              :icon="InfoFilled"
              class="governance-help-btn"
              :aria-label="t('endpointRegistry.governanceGuide.title')"
            />
          </template>
          <div class="governance-guide">
            <div class="governance-guide-title">
              {{ t("endpointRegistry.governanceGuide.title") }}
            </div>
            <div class="governance-guide-section">
              <div class="governance-guide-label">
                {{ t("endpointRegistry.governanceGuide.testingTitle") }}
              </div>
              <p>{{ t("endpointRegistry.governanceGuide.testingDescription") }}</p>
            </div>
            <div class="governance-guide-section">
              <div class="governance-guide-label">
                {{ t("endpointRegistry.governanceGuide.probeTitle") }}
              </div>
              <p>{{ t("endpointRegistry.governanceGuide.probeDescription") }}</p>
            </div>
            <div class="governance-guide-section">
              <div class="governance-guide-label">
                {{ t("endpointRegistry.governanceGuide.readinessTitle") }}
              </div>
              <p>{{ t("endpointRegistry.governanceGuide.readinessDescription") }}</p>
            </div>
            <div class="governance-guide-flow">
              {{ t("endpointRegistry.governanceGuide.flow") }}
            </div>
          </div>
        </el-popover>
        <el-button
          v-if="showCreateButton"
          type="warning"
          @click="openCreateDialog"
        >
          {{ createButtonLabel }}
        </el-button>
        <el-button type="primary" @click="loadOverview" :loading="loading">
          {{ t("common.refresh") }}
        </el-button>
      </div>
    </div>

    <el-card shadow="never" class="toolbar-card">
      <el-row :gutter="12">
        <el-col v-if="!isManualRegistrationView" :xs="24" :md="12">
            <el-radio-group v-model="selectedFilter" size="small">
            <el-radio-button value="all">
              {{ filterLabel.all }}
            </el-radio-button>
            <el-radio-button v-if="currentSurface === 'publication'" value="mcp">
              {{ filterLabel.mcp }}
            </el-radio-button>
            <el-radio-button v-if="currentSurface === 'publication'" value="gateway">
              {{ filterLabel.gateway }}
            </el-radio-button>
            <el-radio-button v-if="currentSurface !== 'publication'" value="manual">
              {{ filterLabel.manual }}
            </el-radio-button>
            <el-radio-button v-if="currentSurface !== 'publication'" value="imported">
              {{ filterLabel.imported }}
            </el-radio-button>
            </el-radio-group>
        </el-col>
        <el-col v-if="currentSurface === 'governance'" :xs="24" :md="12">
          <el-radio-group v-model="selectedTestingState" size="small">
            <el-radio-button value="all">{{ t("endpointRegistry.testingState.all") }}</el-radio-button>
            <el-radio-button value="registered">{{ t("endpointRegistry.testingState.registered") }}</el-radio-button>
            <el-radio-button value="tested">{{ t("endpointRegistry.testingState.tested") }}</el-radio-button>
            <el-radio-button value="test_blocked">{{ t("endpointRegistry.testingState.testBlocked") }}</el-radio-button>
          </el-radio-group>
        </el-col>
        <el-col v-if="currentSurface === 'governance' || currentSurface === 'publication'" :xs="24" :md="12">
          <el-radio-group v-model="selectedReadinessState" size="small">
            <el-radio-button value="all">{{ t("endpointRegistry.readinessState.all") }}</el-radio-button>
            <el-radio-button value="ready">{{ t("endpointRegistry.readinessState.ready") }}</el-radio-button>
            <el-radio-button value="blocked">{{ t("endpointRegistry.readinessState.blocked") }}</el-radio-button>
          </el-radio-group>
        </el-col>
        <el-col :xs="24" :md="isManualRegistrationView ? 24 : 12">
          <el-input
            v-model="search"
            clearable
            :placeholder="t('endpointRegistry.searchPlaceholder')"
          />
        </el-col>
      </el-row>
    </el-card>

    <el-alert
      v-if="errorMessage"
      type="error"
      :title="errorMessage"
      show-icon
      class="mb-12"
    />
    <el-alert
      :title="activeModeHint"
      type="info"
      show-icon
      :closable="false"
      class="mb-12"
    />
    <OperationTimeline
      v-model:visible="operationFeedVisible"
      v-model:expanded="operationFeedExpanded"
      :entries="operationFeed"
      :title="t('endpointRegistry.operationFeed.title')"
      :subtitle="t('endpointRegistry.operationFeed.subtitle')"
      :labels="operationFeedLabels"
      @clear="clearOperationFeed"
    />
    <el-empty
      v-if="showSurfaceEmptyState"
      :description="t('endpointRegistry.empty')"
    />

    <div v-else-if="isManualRegistrationView" class="manual-registration-layout">
      <el-card shadow="never" class="manual-groups-card">
        <template #header>
          <div class="manual-groups-header">
            <span>{{ t("endpointRegistry.groupDirectory") }}</span>
            <span class="count">{{ manualVisibleGroups.length }}</span>
          </div>
        </template>
        <div class="manual-groups-list">
          <button
            v-for="group in manualVisibleGroups"
            :key="group.groupKey"
            type="button"
            class="manual-group-item"
            :class="{ 'is-active': effectiveSelectedManualGroupKey === group.groupKey }"
            @click="selectedManualGroupKey = group.groupKey"
          >
            <div class="manual-group-name">{{ group.groupName }}</div>
            <div class="manual-group-url">{{ group.baseUrl }}</div>
            <div class="manual-group-meta">
              {{ t("endpointRegistry.groupCount", { count: group.endpoints.length }) }}
            </div>
          </button>
        </div>
      </el-card>

      <el-card shadow="never" class="manual-group-detail-card">
        <template #header>
          <div v-if="selectedManualGroup" class="group-title">
            <span class="group-name">{{ selectedManualGroup.groupName }}</span>
            <el-tag type="info">{{ selectedManualGroup.baseUrl }}</el-tag>
            <span class="count">{{
              t("endpointRegistry.groupCount", { count: selectedManualGroup.endpoints.length })
            }}</span>
          </div>
          <span v-else>{{ t("endpointRegistry.noGroupSelected") }}</span>
        </template>

        <el-empty
          v-if="!selectedManualGroup"
          :description="t('endpointRegistry.noGroupSelected')"
        />

        <el-table
          v-else
          :data="selectedManualGroup.endpoints"
          size="small"
          border
          style="width: 100%"
          table-layout="auto"
        >
          <el-table-column prop="name" :label="t('endpointRegistry.table.name')" min-width="180" />
          <el-table-column
            prop="methodPath"
            :label="t('endpointRegistry.table.methodPath')"
            min-width="220"
          />
          <el-table-column
            prop="testStatus"
            :label="t('endpointRegistry.table.testing')"
            width="120"
          >
            <template #default="{ row }">
              <el-tag :type="getTestingTagType(row)">
                {{ getTestingLabel(row) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="lifecycleStatus"
            :label="t('endpointRegistry.table.lifecycle')"
            width="120"
          >
            <template #default="{ row }">
              <el-tag :type="getLifecycleTagType(row.lifecycleStatus)">
                {{ getLifecycleLabel(row.lifecycleStatus) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="lastProbeStatus" :label="t('endpointRegistry.table.probe')" width="120">
            <template #default="{ row }">
              <el-tag :type="getProbeTagType(row.lastProbeStatus)">
                {{ getProbeLabel(row.lastProbeStatus) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            :prop="'lastProbeSummary'"
            :label="probeDetailsLabel"
            min-width="280"
            show-overflow-tooltip
          />
          <el-table-column
            prop="publishEnabled"
            :label="t('endpointRegistry.table.publishEnabled')"
            width="130"
          >
            <template #default="{ row }">
              <el-tag :type="row.publishEnabled ? 'success' : 'info'">
                {{ row.publishEnabled ? t("common.yes") : t("common.no") }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="updatedAtText"
            :label="t('endpointRegistry.table.updatedAt')"
            min-width="180"
          />
          <el-table-column :label="t('endpointRegistry.table.actions')" :width="actionColumnWidth" fixed="right">
            <template #default="{ row }">
              <div class="row-actions manual-row-actions">
                <el-button
                  v-if="showProbeAction || isManualRegistrationView"
                  size="small"
                  :icon="Connection"
                  class="action-btn"
                  @click="handleProbe(row)"
                  :loading="isActionLoading(row.id, 'probe')"
                >
                  {{ t("endpointRegistry.actions.probe") }}
                </el-button>
                <el-button
                  v-if="showTestAction"
                  size="small"
                  type="primary"
                  plain
                  class="action-btn"
                  @click="handleTesting(row)"
                >
                  {{ t("endpointRegistry.actions.test") }}
                </el-button>
                <el-button
                  v-if="showEditAction && row.sourceType === 'manual'"
                  size="small"
                  type="primary"
                  plain
                  :icon="EditIcon"
                  class="action-btn"
                  @click="handleEdit(row)"
                  :loading="isActionLoading(row.id, 'edit')"
                >
                  {{ t("endpointRegistry.actions.edit") }}
                </el-button>
                <el-button
                  v-if="showDeleteAction && row.sourceType === 'manual'"
                  size="small"
                  type="danger"
                  plain
                  :icon="DeleteIcon"
                  class="action-btn delete-action-btn"
                  @click="handleDelete(row)"
                  :loading="isActionLoading(row.id, 'delete')"
                >
                  {{ t("endpointRegistry.actions.delete") }}
                </el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <div v-else-if="isGovernanceCatalogView" class="manual-registration-layout governance-layout">
      <el-card shadow="never" class="manual-groups-card governance-groups-card">
        <template #header>
          <div class="manual-groups-header">
            <span>{{ t("endpointRegistry.groupDirectory") }}</span>
            <span class="count">{{ governanceVisibleGroups.length }}</span>
          </div>
        </template>
        <div class="manual-groups-list">
          <button
            v-for="group in governanceVisibleGroups"
            :key="group.groupKey"
            type="button"
            class="manual-group-item governance-group-item"
            :class="{ 'is-active': effectiveSelectedGovernanceGroupKey === group.groupKey }"
            @click="selectedGovernanceGroupKey = group.groupKey"
          >
            <div class="manual-group-name">{{ group.groupName }}</div>
            <div class="manual-group-url">{{ group.hostPort }}</div>
            <div class="manual-group-base-path">{{ group.basePath }}</div>
            <div class="manual-group-stats">
              <span>{{ t("endpointRegistry.groupCount", { count: group.endpoints.length }) }}</span>
              <span>{{ t("endpointRegistry.groupStats.tested", { count: group.testedCount }) }}</span>
              <span>{{ t("endpointRegistry.groupStats.ready", { count: group.readyCount }) }}</span>
            </div>
            <div class="manual-group-probe">
              <el-tag size="small" :type="getProbeTagType(group.recentProbeStatus)" effect="plain">
                {{ getProbeLabel(group.recentProbeStatus) }}
              </el-tag>
            </div>
          </button>
        </div>
      </el-card>

      <el-card shadow="never" class="manual-group-detail-card governance-group-detail-card">
        <template #header>
          <div v-if="selectedGovernanceGroup" class="group-title governance-group-title">
            <span class="group-name">{{ selectedGovernanceGroup.groupName }}</span>
            <el-tag type="info">{{ selectedGovernanceGroup.hostPort }}</el-tag>
            <el-tag effect="plain">{{ selectedGovernanceGroup.basePath }}</el-tag>
            <span class="count">{{ t("endpointRegistry.groupCount", { count: selectedGovernanceGroup.endpoints.length }) }}</span>
          </div>
          <span v-else>{{ t("endpointRegistry.noGroupSelected") }}</span>
        </template>

        <el-empty
          v-if="!selectedGovernanceGroup"
          :description="t('endpointRegistry.noGroupSelected')"
        />

        <template v-else>
          <div class="governance-group-summary">
            <el-tag type="success" effect="plain">
              {{ t("endpointRegistry.groupStats.tested", { count: selectedGovernanceGroup.testedCount }) }}
            </el-tag>
            <el-tag type="info" effect="plain">
              {{ t("endpointRegistry.groupStats.registered", { count: selectedGovernanceGroup.registeredCount }) }}
            </el-tag>
            <el-tag type="success" effect="plain">
              {{ t("endpointRegistry.groupStats.ready", { count: selectedGovernanceGroup.readyCount }) }}
            </el-tag>
            <el-tag type="warning" effect="plain">
              {{ t("endpointRegistry.groupStats.blocked", { count: selectedGovernanceGroup.blockedCount }) }}
            </el-tag>
            <el-tag :type="getProbeTagType(selectedGovernanceGroup.recentProbeStatus)" effect="plain">
              {{ getProbeLabel(selectedGovernanceGroup.recentProbeStatus) }}
            </el-tag>
          </div>

          <el-table
            :data="selectedGovernanceGroup.endpoints"
            size="small"
            border
            style="width: 100%"
            table-layout="auto"
          >
            <el-table-column prop="name" :label="t('endpointRegistry.table.name')" min-width="180" />
            <el-table-column prop="sourceType" :label="t('endpointRegistry.table.source')" width="110">
              <template #default="{ row }">
                <el-tag :type="getSourceTagType(row)">
                  {{ getSourceLabel(row) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              prop="methodPath"
              :label="t('endpointRegistry.table.methodPath')"
              min-width="220"
            />
            <el-table-column
              prop="testStatus"
              :label="t('endpointRegistry.table.testing')"
              width="120"
            >
              <template #default="{ row }">
                <el-tag :type="getTestingTagType(row)">
                  {{ getTestingLabel(row) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              prop="lifecycleStatus"
              :label="t('endpointRegistry.table.lifecycle')"
              width="120"
            >
              <template #default="{ row }">
                <el-tag :type="getLifecycleTagType(row.lifecycleStatus)">
                  {{ getLifecycleLabel(row.lifecycleStatus) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              prop="readinessState"
              :label="t('endpointRegistry.table.readiness')"
              width="120"
            >
              <template #default="{ row }">
                <el-tag :type="row.readinessState === 'ready' ? 'success' : 'warning'">
                  {{ row.readinessState === "ready" ? t("endpointRegistry.readinessState.ready") : t("endpointRegistry.readinessState.blocked") }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="lastProbeStatus" :label="t('endpointRegistry.table.probe')" width="120">
              <template #default="{ row }">
                <el-tag :type="getProbeTagType(row.lastProbeStatus)">
                  {{ getProbeLabel(row.lastProbeStatus) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              prop="readinessSummary"
              :label="t('endpointRegistry.table.readinessDetails')"
              min-width="280"
              show-overflow-tooltip
            />
            <el-table-column
              prop="publishEnabled"
              :label="t('endpointRegistry.table.publishEnabled')"
              width="130"
            >
              <template #default="{ row }">
                <el-tag :type="row.publishEnabled ? 'success' : 'info'">
                  {{ row.publishEnabled ? t("common.yes") : t("common.no") }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              prop="updatedAtText"
              :label="t('endpointRegistry.table.updatedAt')"
              min-width="180"
            />
            <el-table-column :label="t('endpointRegistry.table.actions')" :width="actionColumnWidth" fixed="right">
              <template #default="{ row }">
                <div class="row-actions governance-row-actions">
                  <el-button
                    size="small"
                    type="warning"
                    plain
                    :icon="Connection"
                    class="action-btn governance-probe-btn"
                    @click="handleProbe(row)"
                    :loading="isActionLoading(row.id, 'probe')"
                  >
                    {{ t("endpointRegistry.actions.probe") }}
                  </el-button>
                  <el-button
                    size="small"
                    type="primary"
                    plain
                    class="action-btn governance-test-btn"
                    @click="handleTesting(row)"
                  >
                    {{ t("endpointRegistry.actions.test") }}
                  </el-button>
                  <el-button
                    size="small"
                    type="success"
                    plain
                    :icon="CircleCheck"
                    class="action-btn governance-readiness-btn"
                    @click="handleReadiness(row)"
                    :loading="isActionLoading(row.id, 'readiness')"
                  >
                    {{ t("endpointRegistry.actions.readiness") }}
                  </el-button>
                  <el-button
                    v-if="showEditAction && (row.sourceType === 'manual' || row.sourceType === 'imported')"
                    size="small"
                    type="info"
                    plain
                    :icon="EditIcon"
                    class="action-btn governance-edit-btn"
                    @click="handleEdit(row)"
                    :loading="isActionLoading(row.id, 'edit')"
                  >
                    {{ row.sourceType === "imported" ? t("endpointRegistry.actions.governance") : t("endpointRegistry.actions.edit") }}
                  </el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </el-card>
    </div>

    <div v-else-if="isPublicationCatalogView" class="publication-surface">
      <el-card shadow="never" class="publication-builder-card">
        <template #header>
          <div class="manual-groups-header">
            <span>{{ t("endpointRegistry.publicationBuilder.title") }}</span>
            <span class="count">{{ publicationCandidateGroups.length }}</span>
          </div>
        </template>
        <div class="publication-builder-toolbar">
          <el-radio-group v-model="selectedPublicationTargetType" size="small">
            <el-radio-button value="mcp_server">{{ filterLabel.mcp }}</el-radio-button>
            <el-radio-button value="gateway_service">{{ filterLabel.gateway }}</el-radio-button>
          </el-radio-group>
          <el-select
            v-model="selectedPublicationTargetRuntimeAssetId"
            clearable
            class="publication-target-select"
            :placeholder="t('endpointRegistry.publicationBuilder.targetPlaceholder')"
          >
            <el-option
              v-for="item in publicationTargetOptions"
              :key="item.asset.id"
              :label="item.asset.displayName || item.asset.name"
              :value="item.asset.id"
            />
          </el-select>
          <el-button type="primary" plain @click="openPublicationTargetDialog">
            {{ t("endpointRegistry.publicationBuilder.createTarget") }}
          </el-button>
          <el-button
            type="success"
            :loading="publicationTargetSaving"
            @click="addSelectedPublicationCandidatesToTarget"
          >
            {{ t("endpointRegistry.publicationBuilder.addCandidates") }}
          </el-button>
        </div>
        <div v-if="selectedPublicationTargetAsset" class="publication-target-summary">
          <el-tag :type="selectedPublicationTargetType === 'gateway_service' ? 'success' : 'primary'">
            {{ selectedPublicationTargetType === "gateway_service" ? filterLabel.gateway : filterLabel.mcp }}
          </el-tag>
          <span class="group-name">
            {{ selectedPublicationTargetAsset.asset.displayName || selectedPublicationTargetAsset.asset.name }}
          </span>
          <span class="count">
            {{ t("endpointRegistry.groupCount", { count: selectedPublicationTargetAsset.membershipCount || 0 }) }}
          </span>
        </div>
        <div class="publication-builder-layout">
          <div
            v-if="publicationCandidateGroups.length > 0"
            class="manual-groups-list publication-builder-groups"
          >
            <button
              v-for="group in publicationCandidateGroups"
              :key="group.groupKey"
              type="button"
              class="manual-group-item publication-candidate-group-item"
              :class="{ 'is-active': effectiveSelectedPublicationCandidateGroupKey === group.groupKey }"
              @click="selectedPublicationCandidateGroupKey = group.groupKey"
            >
              <div class="manual-group-name">{{ group.groupName }}</div>
              <div class="manual-group-url">{{ group.hostPort }}</div>
              <div class="manual-group-base-path">{{ group.basePath }}</div>
              <div class="manual-group-stats">
                <span>{{ t("endpointRegistry.groupStats.ready", { count: group.readyCount }) }}</span>
                <span>{{ t("endpointRegistry.groupStats.blocked", { count: group.blockedCount }) }}</span>
              </div>
            </button>
          </div>
          <el-empty
            v-else
            :description="t('endpointRegistry.publicationBuilder.noCandidates')"
            :image-size="100"
          />
          <div class="publication-builder-detail">
            <el-empty
              v-if="!selectedPublicationCandidateGroup"
              :description="t('endpointRegistry.publicationBuilder.noCandidates')"
            />
            <template v-else>
              <div class="governance-group-summary publication-group-summary">
                <el-tag type="success" effect="plain">
                  {{ t("endpointRegistry.groupStats.ready", { count: selectedPublicationCandidateGroup.readyCount }) }}
                </el-tag>
                <el-tag type="warning" effect="plain">
                  {{ t("endpointRegistry.groupStats.blocked", { count: selectedPublicationCandidateGroup.blockedCount }) }}
                </el-tag>
              </div>
              <el-table
                :data="selectedPublicationCandidateGroup.endpoints"
                size="small"
                border
                style="width: 100%"
                table-layout="auto"
                @selection-change="handlePublicationCandidateSelectionChange"
              >
                <el-table-column type="selection" width="46" />
                <el-table-column prop="name" :label="t('endpointRegistry.table.name')" min-width="180" />
                <el-table-column prop="methodPath" :label="t('endpointRegistry.table.methodPath')" min-width="220" />
                <el-table-column prop="readinessState" :label="t('endpointRegistry.table.readiness')" width="120">
                  <template #default="{ row }">
                    <el-tag :type="row.readinessState === 'ready' ? 'success' : 'warning'">
                      {{ row.readinessState === "ready" ? t("endpointRegistry.readinessState.ready") : t("endpointRegistry.readinessState.blocked") }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="runtimeTargetsSummary" :label="t('endpointRegistry.publicationBuilder.currentTargets')" min-width="220" show-overflow-tooltip />
                <el-table-column prop="readinessSummary" :label="t('endpointRegistry.table.readinessDetails')" min-width="260" show-overflow-tooltip />
              </el-table>
            </template>
          </div>
        </div>
      </el-card>

      <div class="manual-registration-layout publication-layout">
      <el-card shadow="never" class="manual-groups-card publication-groups-card">
        <template #header>
          <div class="manual-groups-header">
            <span>{{ t("endpointRegistry.groupDirectory") }}</span>
            <span class="count">{{ publicationVisibleGroups.length }}</span>
          </div>
        </template>
        <div
          v-if="publicationVisibleGroups.length > 0"
          class="manual-groups-list"
        >
          <button
            v-for="group in publicationVisibleGroups"
            :key="group.groupKey"
            type="button"
            class="manual-group-item publication-group-item"
            :class="{ 'is-active': effectiveSelectedPublicationGroupKey === group.groupKey }"
            @click="selectedPublicationGroupKey = group.groupKey"
          >
            <div class="manual-group-name">{{ group.groupName }}</div>
            <div class="manual-group-url">{{ group.endpoints[0]?.runtimeAssetType === 'gateway_service' ? filterLabel.gateway : filterLabel.mcp }}</div>
            <div class="manual-group-base-path">{{ group.baseUrl }}</div>
            <div class="manual-group-stats">
              <span>{{ t("endpointRegistry.groupCount", { count: group.endpoints.length }) }}</span>
              <span>{{ t("endpointRegistry.groupStats.ready", { count: group.readyCount }) }}</span>
              <span>{{ t("endpointRegistry.groupStats.active", { count: group.activeCount }) }}</span>
            </div>
            <div class="manual-group-probe">
              <el-tag size="small" :type="getProbeTagType(group.recentProbeStatus)" effect="plain">
                {{ getProbeLabel(group.recentProbeStatus) }}
              </el-tag>
            </div>
          </button>
        </div>
        <el-empty
          v-else
          :description="t('endpointRegistry.noGroupSelected')"
          :image-size="100"
        />
      </el-card>

      <el-card shadow="never" class="manual-group-detail-card publication-group-detail-card">
        <template #header>
          <div v-if="selectedPublicationGroup" class="group-title publication-group-title">
            <span class="group-name">{{ selectedPublicationGroup.groupName }}</span>
            <el-tag :type="selectedPublicationGroup.endpoints[0]?.runtimeAssetType === 'gateway_service' ? 'success' : 'primary'">
              {{ selectedPublicationGroup.endpoints[0]?.runtimeAssetType === "gateway_service" ? filterLabel.gateway : filterLabel.mcp }}
            </el-tag>
            <el-tag effect="plain">{{ selectedPublicationGroup.baseUrl }}</el-tag>
            <span class="count">{{ t("endpointRegistry.groupCount", { count: selectedPublicationGroup.endpoints.length }) }}</span>
          </div>
          <span v-else>{{ t("endpointRegistry.noGroupSelected") }}</span>
        </template>

        <el-empty
          v-if="!selectedPublicationGroup"
          :description="t('endpointRegistry.noGroupSelected')"
        />

        <template v-else>
          <div class="governance-group-summary publication-group-summary">
            <el-tag type="success" effect="plain">
              {{ t("endpointRegistry.groupStats.ready", { count: selectedPublicationGroup.readyCount }) }}
            </el-tag>
            <el-tag type="warning" effect="plain">
              {{ t("endpointRegistry.groupStats.blocked", { count: selectedPublicationGroup.blockedCount }) }}
            </el-tag>
            <el-tag type="success" effect="plain">
              {{ t("endpointRegistry.groupStats.active", { count: selectedPublicationGroup.activeCount }) }}
            </el-tag>
            <el-tag type="warning" effect="plain">
              {{ t("endpointRegistry.groupStats.offline", { count: selectedPublicationGroup.offlineCount }) }}
            </el-tag>
            <el-tag :type="getProbeTagType(selectedPublicationGroup.recentProbeStatus)" effect="plain">
              {{ getProbeLabel(selectedPublicationGroup.recentProbeStatus) }}
            </el-tag>
          </div>

          <el-card v-if="selectedPublicationMembershipRow" shadow="never" class="publication-workbench-card">
            <template #header>
              <div class="manual-groups-header">
                <span>{{ t("endpointRegistry.publicationWorkbench.title") }}</span>
                <span class="count">{{ selectedPublicationMembershipRow.methodPath }}</span>
              </div>
            </template>
            <div class="publication-workbench-summary">
              <el-tag :type="selectedPublicationMembershipRow.runtimeAssetType === 'gateway_service' ? 'success' : 'primary'">
                {{ selectedPublicationMembershipRow.runtimeAssetType === "gateway_service" ? filterLabel.gateway : filterLabel.mcp }}
              </el-tag>
              <el-tag :type="getPublicationStateTagType(selectedPublicationMembershipRow.publicationState)">
                {{ getPublicationStateLabel(selectedPublicationMembershipRow.publicationState) }}
              </el-tag>
              <el-tag :type="getProfileStatusTagType(selectedPublicationMembershipRow.publicationProfileStatus)">
                {{ getProfileStatusLabel(selectedPublicationMembershipRow.publicationProfileStatus) }}
              </el-tag>
              <el-tag :type="getRouteConfigTagType(selectedPublicationMembershipRow)" effect="plain">
                {{ getRouteConfigLabel(selectedPublicationMembershipRow) }}
              </el-tag>
              <el-tag :type="selectedPublicationMembershipRow.readinessState === 'ready' ? 'success' : 'warning'" effect="plain">
                {{ selectedPublicationMembershipRow.readinessState === "ready" ? t("endpointRegistry.readinessState.ready") : t("endpointRegistry.readinessState.blocked") }}
              </el-tag>
            </div>
            <div class="publication-workbench-body">
              <div class="publication-workbench-meta">
                <div class="publication-workbench-item">
                  <div class="publication-workbench-label">{{ t("endpointRegistry.table.runtimeAsset") }}</div>
                  <div class="publication-workbench-value">{{ selectedPublicationMembershipRow.runtimeAssetName || "-" }}</div>
                </div>
                <div class="publication-workbench-item">
                  <div class="publication-workbench-label">{{ t("endpointRegistry.table.revision") }}</div>
                  <div class="publication-workbench-value">{{ selectedPublicationMembershipRow.publicationRevision || 0 }}</div>
                </div>
                <div class="publication-workbench-item">
                  <div class="publication-workbench-label">{{ t("endpointRegistry.table.targetConfig") }}</div>
                  <div class="publication-workbench-value">{{ selectedPublicationMembershipRow.publicationConfigSummary || "-" }}</div>
                </div>
              </div>
              <div class="publication-flow">
                <div
                  v-for="stage in getPublicationFlowStages(selectedPublicationMembershipRow, selectedPublicationRuntimeAsset)"
                  :key="stage.key"
                  class="publication-flow-stage"
                >
                  <div class="publication-workbench-label">{{ stage.label }}</div>
                  <el-tag :type="getPublicationFlowStageTagType(stage.status)" effect="plain">
                    {{ getPublicationFlowStageStatusLabel(stage.status) }}
                  </el-tag>
                  <div class="publication-workbench-value publication-flow-stage-hint">{{ stage.hint }}</div>
                </div>
              </div>
              <div v-if="selectedPublicationRuntimeAsset" class="publication-runtime-handoff">
                <div class="publication-runtime-handoff-header">
                  <span class="group-name">{{ t("endpointRegistry.runtimeHandoff.title") }}</span>
                  <el-tag :type="getRuntimeStatusTagType(selectedPublicationRuntimeAsset.runtimeSummary?.runtimeStatus || selectedPublicationRuntimeAsset.asset.status)" effect="plain">
                    {{ getRuntimeStatusLabel(selectedPublicationRuntimeAsset.runtimeSummary?.runtimeStatus || selectedPublicationRuntimeAsset.asset.status) }}
                  </el-tag>
                </div>
                <div class="publication-runtime-handoff-hint">
                  {{ getRuntimeHandoffHint(selectedPublicationRuntimeAsset) }}
                </div>
                <div class="publication-runtime-handoff-meta">
                  <div class="publication-workbench-item">
                    <div class="publication-workbench-label">{{ t("endpointRegistry.runtimeHandoff.memberships") }}</div>
                    <div class="publication-workbench-value">
                      {{ selectedPublicationRuntimeAsset.runtimeSummary?.membershipCount ?? selectedPublicationRuntimeAsset.membershipCount ?? 0 }}
                    </div>
                  </div>
                  <div class="publication-workbench-item">
                    <div class="publication-workbench-label">{{ t("endpointRegistry.runtimeHandoff.activeMemberships") }}</div>
                    <div class="publication-workbench-value">
                      {{ selectedPublicationRuntimeAsset.runtimeSummary?.activeMembershipCount ?? selectedPublicationRuntimeAsset.activeMembershipCount ?? 0 }}
                    </div>
                  </div>
                  <div class="publication-workbench-item">
                    <div class="publication-workbench-label">{{ t("endpointRegistry.runtimeHandoff.endpoint") }}</div>
                    <div class="publication-workbench-value">
                      {{ selectedPublicationRuntimeAsset.managedServer?.endpoint || "-" }}
                    </div>
                  </div>
                </div>
                <div class="row-actions publication-workbench-actions">
                  <el-button
                    size="small"
                    type="primary"
                    class="action-btn"
                    @click="executeRuntimeAssetAction(selectedPublicationRuntimeAsset.asset.id, 'deploy', selectedPublicationRuntimeAsset.asset.type)"
                    :disabled="isRuntimeActionDisabled('deploy', selectedPublicationRuntimeAsset)"
                    :loading="isActionLoading(selectedPublicationRuntimeAsset.asset.id, 'deploy')"
                  >
                    {{ t("endpointRegistry.runtimeActions.deploy") }}
                  </el-button>
                  <el-button
                    size="small"
                    type="success"
                    class="action-btn"
                    @click="executeRuntimeAssetAction(selectedPublicationRuntimeAsset.asset.id, 'start', selectedPublicationRuntimeAsset.asset.type)"
                    :disabled="isRuntimeActionDisabled('start', selectedPublicationRuntimeAsset)"
                    :loading="isActionLoading(selectedPublicationRuntimeAsset.asset.id, 'start')"
                  >
                    {{ t("endpointRegistry.runtimeActions.start") }}
                  </el-button>
                  <el-button
                    size="small"
                    type="warning"
                    class="action-btn"
                    @click="executeRuntimeAssetAction(selectedPublicationRuntimeAsset.asset.id, 'stop', selectedPublicationRuntimeAsset.asset.type)"
                    :disabled="isRuntimeActionDisabled('stop', selectedPublicationRuntimeAsset)"
                    :loading="isActionLoading(selectedPublicationRuntimeAsset.asset.id, 'stop')"
                  >
                    {{ t("endpointRegistry.runtimeActions.stop") }}
                  </el-button>
                  <el-button
                    size="small"
                    plain
                    class="action-btn"
                    @click="executeRuntimeAssetAction(selectedPublicationRuntimeAsset.asset.id, 'redeploy', selectedPublicationRuntimeAsset.asset.type)"
                    :disabled="isRuntimeActionDisabled('redeploy', selectedPublicationRuntimeAsset)"
                    :loading="isActionLoading(selectedPublicationRuntimeAsset.asset.id, 'redeploy')"
                  >
                    {{ t("endpointRegistry.runtimeActions.redeploy") }}
                  </el-button>
                </div>
              </div>
              <div class="publication-traceability">
                <div class="publication-workbench-item">
                  <div class="publication-workbench-label">{{ t("endpointRegistry.traceability.runtimeMembershipId") }}</div>
                  <div class="publication-workbench-value">{{ selectedPublicationMembershipRow.runtimeMembershipId || "-" }}</div>
                </div>
                <div class="publication-workbench-item">
                  <div class="publication-workbench-label">{{ t("endpointRegistry.traceability.runtimeAssetId") }}</div>
                  <div class="publication-workbench-value">{{ selectedPublicationMembershipRow.runtimeAssetId || "-" }}</div>
                </div>
                <div class="publication-workbench-item">
                  <div class="publication-workbench-label">{{ t("endpointRegistry.traceability.endpointDefinitionId") }}</div>
                  <div class="publication-workbench-value">{{ selectedPublicationMembershipRow.endpointDefinitionId || "-" }}</div>
                </div>
                <div class="publication-workbench-item">
                  <div class="publication-workbench-label">{{ t("endpointRegistry.traceability.sourceServiceAssetId") }}</div>
                  <div class="publication-workbench-value">{{ selectedPublicationMembershipRow.sourceServiceAssetId || "-" }}</div>
                </div>
                <div class="publication-workbench-item">
                  <div class="publication-workbench-label">{{ t("endpointRegistry.traceability.runtimeCarrier") }}</div>
                  <div class="publication-workbench-value">
                    {{ selectedPublicationRuntimeAsset?.managedServer?.id || t("endpointRegistry.traceability.notBound") }}
                  </div>
                </div>
                <div class="publication-workbench-item">
                  <div class="publication-workbench-label">{{ t("endpointRegistry.traceability.nextStep") }}</div>
                  <div class="publication-workbench-value">
                    {{ getPublicationNextStepHint(selectedPublicationMembershipRow, selectedPublicationRuntimeAsset) }}
                  </div>
                </div>
              </div>
              <div class="publication-checklist">
                <div
                  v-for="item in getPublicationChecklist(selectedPublicationMembershipRow)"
                  :key="item.key"
                  class="publication-checklist-item"
                >
                  <div class="publication-workbench-label">{{ item.label }}</div>
                  <el-tag
                    :type="item.applicable === false ? 'info' : item.passed ? 'success' : 'warning'"
                    effect="plain"
                  >
                    {{
                      item.applicable === false
                        ? t("endpointRegistry.publicationWorkbench.notApplicable")
                        : item.passed
                          ? t("endpointRegistry.publicationWorkbench.checkPassed")
                          : t("endpointRegistry.publicationWorkbench.checkBlocked")
                    }}
                  </el-tag>
                </div>
              </div>
              <el-alert
                v-if="selectedPublicationMembershipRow.readinessState !== 'ready'"
                :title="t('endpointRegistry.publicationWorkbench.blockedTitle')"
                type="warning"
                show-icon
                :closable="false"
              >
                <template #default>
                  <div
                    v-for="group in getPublicationBlockerGroups(selectedPublicationMembershipRow)"
                    :key="group.key"
                    class="publication-blocker-group"
                  >
                    <div class="publication-blocker-group-title">
                      {{ getPublicationBlockerGroupLabel(group.key) }}
                    </div>
                    <ul class="publication-blocker-list">
                      <li
                        v-for="reason in group.reasons"
                        :key="reason"
                      >
                        {{ reason }}
                      </li>
                    </ul>
                  </div>
                </template>
              </el-alert>
              <div class="row-actions publication-workbench-actions">
                <el-button
                  size="small"
                  type="info"
                  plain
                  :icon="EditIcon"
                  class="action-btn"
                  @click="handleEdit(selectedPublicationMembershipRow)"
                  :loading="isActionLoading(selectedPublicationMembershipRow.id, 'edit')"
                >
                  {{ t("endpointRegistry.actions.configure") }}
                </el-button>
                <el-button
                  size="small"
                  type="success"
                  :icon="UploadFilled"
                  class="action-btn"
                  @click="handlePublish(selectedPublicationMembershipRow)"
                  :disabled="selectedPublicationMembershipRow.readinessState !== 'ready'"
                  :loading="isActionLoading(selectedPublicationMembershipRow.id, 'publish')"
                >
                  {{ getPublicationActionLabel(selectedPublicationMembershipRow) }}
                </el-button>
                <el-button
                  size="small"
                  type="warning"
                  :icon="SwitchButton"
                  class="action-btn"
                  @click="handleOffline(selectedPublicationMembershipRow)"
                  :disabled="selectedPublicationMembershipRow.publicationState !== 'active'"
                  :loading="isActionLoading(selectedPublicationMembershipRow.id, 'offline')"
                >
                  {{ getOfflineActionLabel(selectedPublicationMembershipRow) }}
                </el-button>
                <el-button
                  v-if="selectedPublicationMembershipRow.runtimeAssetId"
                  size="small"
                  plain
                  class="action-btn"
                  @click="handleViewRuntime(selectedPublicationMembershipRow)"
                >
                  {{ t("endpointRegistry.actions.viewRuntime") }}
                </el-button>
              </div>
            </div>
          </el-card>

          <div v-if="selectedPublicationGroup" class="publication-batch-toolbar">
            <div class="publication-batch-summary">
              <el-tag type="info" effect="plain">
                {{ t("endpointRegistry.batchActions.selected", { count: selectedPublicationMembershipRows.length }) }}
              </el-tag>
              <el-tag type="success" effect="plain">
                {{ t("endpointRegistry.batchActions.publishable", { count: batchPublicationPublishableCount }) }}
              </el-tag>
              <el-tag type="warning" effect="plain">
                {{ t("endpointRegistry.batchActions.offlineable", { count: batchPublicationOfflineableCount }) }}
              </el-tag>
            </div>
            <div class="row-actions publication-workbench-actions">
              <el-button
                v-if="selectedPublicationRuntimeAsset"
                size="small"
                type="primary"
                class="action-btn"
                @click="executeRuntimeAssetAction(selectedPublicationRuntimeAsset.asset.id, 'deploy', selectedPublicationRuntimeAsset.asset.type)"
                :disabled="isRuntimeActionDisabled('deploy', selectedPublicationRuntimeAsset)"
                :loading="isActionLoading(selectedPublicationRuntimeAsset.asset.id, 'deploy')"
              >
                {{ t("endpointRegistry.batchActions.deployRuntime") }}
              </el-button>
              <el-button
                v-if="selectedPublicationRuntimeAsset"
                size="small"
                type="success"
                class="action-btn"
                @click="executeRuntimeAssetAction(selectedPublicationRuntimeAsset.asset.id, 'start', selectedPublicationRuntimeAsset.asset.type)"
                :disabled="isRuntimeActionDisabled('start', selectedPublicationRuntimeAsset)"
                :loading="isActionLoading(selectedPublicationRuntimeAsset.asset.id, 'start')"
              >
                {{ t("endpointRegistry.batchActions.startRuntime") }}
              </el-button>
              <el-button
                size="small"
                plain
                class="action-btn"
                @click="selectPublicationMembershipRows('publishable')"
              >
                {{ t("endpointRegistry.batchActions.selectPublishable") }}
              </el-button>
              <el-button
                size="small"
                plain
                class="action-btn"
                @click="selectPublicationMembershipRows('active')"
              >
                {{ t("endpointRegistry.batchActions.selectActive") }}
              </el-button>
              <el-button
                size="small"
                type="success"
                class="action-btn"
                @click="handleBatchPublicationAction('publish')"
                :disabled="batchPublicationPublishableCount === 0"
                :loading="batchPublicationActionLoading === 'publish'"
              >
                {{ t("endpointRegistry.batchActions.publish") }}
              </el-button>
              <el-button
                size="small"
                type="warning"
                class="action-btn"
                @click="handleBatchPublicationAction('offline')"
                :disabled="batchPublicationOfflineableCount === 0"
                :loading="batchPublicationActionLoading === 'offline'"
              >
                {{ t("endpointRegistry.batchActions.offline") }}
              </el-button>
              <el-button
                size="small"
                plain
                class="action-btn"
                @click="clearPublicationMembershipSelection"
                :disabled="selectedPublicationMembershipRows.length === 0"
              >
                {{ t("endpointRegistry.batchActions.clearSelection") }}
              </el-button>
            </div>
          </div>

          <el-alert
            v-if="lastPublicationBatchRun"
            :title="getLastBatchRunTitle(lastPublicationBatchRun)"
            :type="getLastBatchRunAlertType(lastPublicationBatchRun)"
            show-icon
            :closable="false"
            class="mb-12"
          >
            <template #default>
              <div class="publication-batch-result">
                <div>{{ getLastBatchRunSummary(lastPublicationBatchRun) }}</div>
                <div class="publication-batch-next">{{ getLastBatchRunNextStep(lastPublicationBatchRun) }}</div>
              </div>
            </template>
          </el-alert>

          <el-card
            v-if="selectedPublicationGroup"
            shadow="never"
            class="publication-activity-card"
          >
            <template #header>
              <div class="manual-groups-header">
                <span>{{ t("endpointRegistry.batchActions.activityTitle") }}</span>
                <span class="count">{{ publicationActivityEntries.length }}</span>
              </div>
            </template>
            <el-empty
              v-if="publicationActivityEntries.length === 0"
              :description="t('endpointRegistry.batchActions.activityEmpty')"
              :image-size="100"
            />
            <div v-else class="publication-activity-list">
              <div
                v-for="entry in publicationActivityEntries"
                :key="entry.id"
                class="publication-activity-item"
              >
                <div class="publication-activity-top">
                  <el-tag :type="getActivityLevelTagType(entry.level)" size="small" effect="plain">
                    {{ operationFeedLabels.levels[entry.level] }}
                  </el-tag>
                  <span class="publication-activity-time">{{ formatActivityTimestamp(entry.timestamp) }}</span>
                </div>
                <div class="publication-activity-title">{{ entry.title }}</div>
                <div class="publication-activity-summary">{{ entry.summary }}</div>
                <div v-if="entry.details" class="publication-activity-details">{{ entry.details }}</div>
              </div>
            </div>
          </el-card>

          <el-table
            ref="publicationMembershipTableRef"
            :data="selectedPublicationGroup.endpoints"
            size="small"
            border
            style="width: 100%"
            table-layout="auto"
            highlight-current-row
            :current-row-key="effectiveSelectedPublicationMembershipRowId"
            row-key="id"
            reserve-selection
            @selection-change="handlePublicationMembershipSelectionChange"
            @current-change="(row?: EndpointRow) => { selectedPublicationMembershipRowId = row?.id || ''; }"
          >
            <el-table-column type="selection" width="48" />
            <el-table-column prop="name" :label="t('endpointRegistry.table.name')" min-width="180" />
            <el-table-column
              prop="runtimeAssetName"
              :label="t('endpointRegistry.table.runtimeAsset')"
              min-width="180"
            />
            <el-table-column
              prop="publicationRevision"
              :label="t('endpointRegistry.table.revision')"
              width="100"
            />
            <el-table-column
              prop="methodPath"
              :label="t('endpointRegistry.table.methodPath')"
              min-width="220"
            />
            <el-table-column
              prop="readinessState"
              :label="t('endpointRegistry.table.readiness')"
              width="120"
            >
              <template #default="{ row }">
                <el-tag :type="row.readinessState === 'ready' ? 'success' : 'warning'">
                  {{ row.readinessState === "ready" ? t("endpointRegistry.readinessState.ready") : t("endpointRegistry.readinessState.blocked") }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              prop="publicationState"
              :label="t('endpointRegistry.table.publishState')"
              width="140"
            >
              <template #default="{ row }">
                <el-tag :type="getPublicationStateTagType(row.publicationState)">
                  {{ getPublicationStateLabel(row.publicationState) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              prop="publicationProfileStatus"
              :label="t('endpointRegistry.table.profile')"
              width="120"
            >
              <template #default="{ row }">
                <el-tag :type="getProfileStatusTagType(row.publicationProfileStatus)">
                  {{ getProfileStatusLabel(row.publicationProfileStatus) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="lastProbeStatus" :label="t('endpointRegistry.table.probe')" width="120">
              <template #default="{ row }">
                <el-tag :type="getProbeTagType(row.lastProbeStatus)">
                  {{ getProbeLabel(row.lastProbeStatus) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              prop="publicationConfigSummary"
              :label="t('endpointRegistry.table.targetConfig')"
              min-width="220"
              show-overflow-tooltip
            />
            <el-table-column
              prop="readinessSummary"
              :label="t('endpointRegistry.table.readinessDetails')"
              min-width="280"
              show-overflow-tooltip
            />
            <el-table-column
              prop="updatedAtText"
              :label="t('endpointRegistry.table.updatedAt')"
              min-width="180"
            />
            <el-table-column :label="t('endpointRegistry.table.actions')" :width="actionColumnWidth" fixed="right">
              <template #default="{ row }">
                <div class="row-actions publication-row-actions">
                  <el-button
                    size="small"
                    type="success"
                    :icon="UploadFilled"
                    class="action-btn"
                    @click="handlePublish(row)"
                    :disabled="row.readinessState !== 'ready'"
                    :loading="isActionLoading(row.id, 'publish')"
                  >
                    {{ getPublicationActionLabel(row) }}
                  </el-button>
                  <el-button
                    size="small"
                    type="warning"
                    :icon="SwitchButton"
                    class="action-btn"
                    @click="handleOffline(row)"
                    :disabled="row.publicationState !== 'active'"
                    :loading="isActionLoading(row.id, 'offline')"
                  >
                    {{ getOfflineActionLabel(row) }}
                  </el-button>
                  <el-button
                    size="small"
                    type="info"
                    plain
                    :icon="EditIcon"
                    class="action-btn"
                    @click="handleEdit(row)"
                    :loading="isActionLoading(row.id, 'edit')"
                  >
                    {{ t("endpointRegistry.actions.configure") }}
                  </el-button>
                  <el-button
                    v-if="row.runtimeAssetId"
                    size="small"
                    plain
                    class="action-btn"
                    @click="handleViewRuntime(row)"
                  >
                    {{ t("endpointRegistry.actions.viewRuntime") }}
                  </el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </el-card>
      </div>
    </div>

    <el-collapse v-else v-model="expandedGroupKeys">
      <el-collapse-item
        v-for="group in filteredGroups"
        :key="group.groupKey"
        :name="group.groupKey"
      >
        <template #title>
          <div class="group-title">
            <span class="group-name">{{ group.groupName }}</span>
            <el-tag type="info">{{ group.baseUrl }}</el-tag>
            <span class="count">{{
              t("endpointRegistry.groupCount", { count: group.endpoints.length })
            }}</span>
          </div>
        </template>

        <el-table :data="group.endpoints" size="small" border style="width: 100%" table-layout="auto">
          <el-table-column prop="name" :label="t('endpointRegistry.table.name')" min-width="180" />
          <el-table-column
            prop="sourceType"
            :label="currentSurface === 'publication' ? t('endpointRegistry.table.target') : t('endpointRegistry.table.source')"
            width="110"
          >
            <template #default="{ row }">
              <el-tag :type="getSourceTagType(row)">
                {{ getSourceLabel(row) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            v-if="currentSurface === 'publication'"
            prop="runtimeAssetName"
            :label="t('endpointRegistry.table.runtimeAsset')"
            min-width="180"
          />
          <el-table-column
            v-if="currentSurface === 'publication'"
            prop="publicationRevision"
            :label="t('endpointRegistry.table.revision')"
            width="100"
          />
          <el-table-column
            prop="methodPath"
            :label="t('endpointRegistry.table.methodPath')"
            min-width="220"
          />
          <el-table-column
            v-if="currentSurface !== 'publication'"
            prop="testStatus"
            :label="t('endpointRegistry.table.testing')"
            width="120"
          >
            <template #default="{ row }">
              <el-tag :type="getTestingTagType(row)">
                {{ getTestingLabel(row) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="lifecycleStatus"
            :label="t('endpointRegistry.table.lifecycle')"
            width="120"
          >
            <template #default="{ row }">
              <el-tag :type="getLifecycleTagType(row.lifecycleStatus)">
                {{ getLifecycleLabel(row.lifecycleStatus) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            v-if="currentSurface === 'governance' || currentSurface === 'publication'"
            prop="readinessState"
            :label="t('endpointRegistry.table.readiness')"
            width="120"
          >
            <template #default="{ row }">
              <el-tag :type="row.readinessState === 'ready' ? 'success' : 'warning'">
                {{ row.readinessState === "ready" ? t("endpointRegistry.readinessState.ready") : t("endpointRegistry.readinessState.blocked") }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            v-if="currentSurface === 'publication'"
            prop="publicationState"
            :label="t('endpointRegistry.table.publishState')"
            width="140"
          >
            <template #default="{ row }">
              <el-tag :type="getPublicationStateTagType(row.publicationState)">
                {{ getPublicationStateLabel(row.publicationState) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            v-if="currentSurface === 'publication'"
            prop="publicationProfileStatus"
            :label="t('endpointRegistry.table.profile')"
            width="120"
          >
            <template #default="{ row }">
              <el-tag :type="getProfileStatusTagType(row.publicationProfileStatus)">
                {{ getProfileStatusLabel(row.publicationProfileStatus) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="lastProbeStatus" :label="t('endpointRegistry.table.probe')" width="120">
            <template #default="{ row }">
              <el-tag :type="getProbeTagType(row.lastProbeStatus)">
                {{ getProbeLabel(row.lastProbeStatus) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            v-if="currentSurface === 'publication'"
            prop="publicationConfigSummary"
            :label="t('endpointRegistry.table.targetConfig')"
            min-width="220"
            show-overflow-tooltip
          />
          <el-table-column
            :prop="currentSurface === 'publication' || currentSurface === 'governance' ? 'readinessSummary' : 'lastProbeSummary'"
            :label="
              currentSurface === 'publication' || currentSurface === 'governance'
                ? t('endpointRegistry.table.readinessDetails')
                : probeDetailsLabel
            "
            min-width="280"
            show-overflow-tooltip
          />
          <el-table-column
            prop="publishEnabled"
            :label="t('endpointRegistry.table.publishEnabled')"
            width="130"
          >
            <template #default="{ row }">
              <el-tag :type="row.publishEnabled ? 'success' : 'info'">
                {{ row.publishEnabled ? t("common.yes") : t("common.no") }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="updatedAtText"
            :label="t('endpointRegistry.table.updatedAt')"
            min-width="180"
          />
          <el-table-column :label="t('endpointRegistry.table.actions')" :width="actionColumnWidth" fixed="right">
            <template #default="{ row }">
              <div class="row-actions">
                <el-button
                  v-if="showProbeAction"
                  size="small"
                  :icon="Connection"
                  class="action-btn"
                  @click="handleProbe(row)"
                  :loading="isActionLoading(row.id, 'probe')"
                >
                  {{ t("endpointRegistry.actions.probe") }}
                </el-button>
                <el-button
                  v-if="showTestAction"
                  size="small"
                  type="primary"
                  plain
                  class="action-btn"
                  @click="handleTesting(row)"
                >
                  {{ t("endpointRegistry.actions.test") }}
                </el-button>
                <el-button
                  v-if="showReadinessAction"
                  size="small"
                  :icon="CircleCheck"
                  class="action-btn"
                  @click="handleReadiness(row)"
                  :loading="isActionLoading(row.id, 'readiness')"
                >
                  {{ t("endpointRegistry.actions.readiness") }}
                </el-button>
                <el-button
                  v-if="showPublishAction"
                  size="small"
                  type="success"
                  :icon="UploadFilled"
                  class="action-btn"
                  @click="handlePublish(row)"
                  :disabled="currentSurface === 'publication' && row.readinessState !== 'ready'"
                  :loading="isActionLoading(row.id, 'publish')"
                >
                  {{ currentSurface === "publication" ? getPublicationActionLabel(row) : t("endpointRegistry.actions.publish") }}
                </el-button>
                <el-button
                  v-if="showOfflineAction"
                  size="small"
                  type="warning"
                  :icon="SwitchButton"
                  class="action-btn"
                  @click="handleOffline(row)"
                  :disabled="currentSurface === 'publication' && row.publicationState !== 'active'"
                  :loading="isActionLoading(row.id, 'offline')"
                >
                  {{ currentSurface === "publication" ? getOfflineActionLabel(row) : t("endpointRegistry.actions.offline") }}
                </el-button>
                <el-button
                  v-if="showEditAction && (row.sourceType === 'manual' || currentSurface === 'governance' || currentSurface === 'publication')"
                  size="small"
                  type="primary"
                  plain
                  :icon="EditIcon"
                  class="action-btn"
                  @click="handleEdit(row)"
                  :loading="isActionLoading(row.id, 'edit')"
                >
                  {{
                    currentSurface === "publication"
                      ? t("endpointRegistry.actions.configure")
                      : row.sourceType === "imported"
                      ? t("endpointRegistry.actions.governance")
                      : t("endpointRegistry.actions.edit")
                  }}
                </el-button>
                <el-button
                  v-if="currentSurface === 'publication' && row.runtimeAssetId"
                  size="small"
                  plain
                  class="action-btn"
                  @click="handleViewRuntime(row)"
                >
                  {{ t("endpointRegistry.actions.viewRuntime") }}
                </el-button>
                <el-button
                  v-if="showDeleteAction && row.sourceType === 'manual'"
                  size="small"
                  type="danger"
                  plain
                  :icon="DeleteIcon"
                  class="action-btn delete-action-btn"
                  @click="handleDelete(row)"
                  :loading="isActionLoading(row.id, 'delete')"
                >
                  {{ t("endpointRegistry.actions.delete") }}
                </el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-collapse-item>
    </el-collapse>

    <el-dialog
      v-model="showCreateDialog"
      :title="dialogTitle"
      width="640px"
      align-center
      @closed="resetCreateForm"
    >
      <el-form
        ref="createFormRef"
        :model="createForm"
        :rules="createFormRules"
        label-width="130px"
      >
        <el-alert
          v-if="isImportedGovernanceEdit"
          :title="isGovernanceEdit ? t('endpointRegistry.messages.governanceEditHint') : t('endpointRegistry.messages.importedEditHint')"
          type="info"
          show-icon
          :closable="false"
          class="mb-12"
        />
        <el-form-item :label="t('endpointRegistry.form.name')" prop="name">
          <el-input
            v-model="createForm.name"
            clearable
            :disabled="isImportedGovernanceEdit"
            :placeholder="t('endpointRegistry.form.namePlaceholder')"
          />
        </el-form-item>
        <el-form-item
          v-if="!isImportedGovernanceEdit"
          :label="t('endpointRegistry.form.baseUrl')"
          prop="baseUrl"
        >
          <el-input
            v-model="createForm.baseUrl"
            clearable
            :placeholder="t('endpointRegistry.form.baseUrlPlaceholder')"
          />
        </el-form-item>
        <el-form-item
          v-if="!isImportedGovernanceEdit"
          :label="t('endpointRegistry.form.method')"
          prop="method"
        >
          <el-select v-model="createForm.method" style="width: 100%">
            <el-option label="GET" value="GET" />
            <el-option label="POST" value="POST" />
            <el-option label="PUT" value="PUT" />
            <el-option label="PATCH" value="PATCH" />
            <el-option label="DELETE" value="DELETE" />
          </el-select>
        </el-form-item>
        <el-form-item
          v-if="!isImportedGovernanceEdit"
          :label="t('endpointRegistry.form.path')"
          prop="path"
        >
          <el-input
            v-model="createForm.path"
            clearable
            :placeholder="t('endpointRegistry.form.pathPlaceholder')"
          />
        </el-form-item>
        <el-form-item v-if="!isImportedGovernanceEdit" :label="t('endpointRegistry.form.description')">
          <el-input v-model="createForm.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.businessDomain')">
          <el-input
            v-model="createForm.businessDomain"
            clearable
            :placeholder="t('endpointRegistry.form.businessDomainPlaceholder')"
          />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.riskLevel')">
          <el-select v-model="createForm.riskLevel" style="width: 100%">
            <el-option :label="t('endpointRegistry.options.riskLevel.low')" value="low" />
            <el-option :label="t('endpointRegistry.options.riskLevel.medium')" value="medium" />
            <el-option :label="t('endpointRegistry.options.riskLevel.high')" value="high" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="isGovernanceEdit" :label="t('endpointRegistry.form.allowPublication')">
          <el-switch v-model="createForm.publishEnabled" />
        </el-form-item>
        <el-form-item
          v-if="isImportedGovernanceEdit"
          :label="t('endpointRegistry.form.probeUrl')"
        >
          <el-input
            v-model="createForm.probeUrl"
            clearable
            :placeholder="t('endpointRegistry.form.probeUrlPlaceholder')"
          />
        </el-form-item>
        <el-form-item v-if="isGovernanceEdit" :label="t('endpointRegistry.form.governanceOwner')">
          <el-input
            v-model="createForm.governanceOwner"
            clearable
            :placeholder="t('endpointRegistry.form.governanceOwnerPlaceholder')"
          />
        </el-form-item>
        <el-form-item v-if="isGovernanceEdit" :label="t('endpointRegistry.form.governanceNotes')">
          <el-input v-model="createForm.governanceNotes" type="textarea" :rows="3" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="showCreateDialog = false">{{ t("common.cancel") }}</el-button>
          <el-button
            v-if="currentSurface === 'registration' && !isImportedGovernanceEdit"
            type="warning"
            :loading="testingFromDialog"
            @click="submitCreateFormAndGoTesting"
          >
            {{ testingFromDialog ? t("common.testing") : t("endpointRegistry.actions.test") }}
          </el-button>
          <el-button type="primary" :loading="creating" @click="submitCreateForm">
            {{
              creating
                ? t(isEditMode ? "common.updating" : "endpointRegistry.messages.submitting")
                : t(isEditMode ? "common.update" : "common.create")
            }}
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="showPublicationTargetDialog"
      :title="t('endpointRegistry.publicationBuilder.createTarget')"
      width="640px"
      align-center
      @closed="resetPublicationTargetForm"
    >
      <el-form :model="publicationTargetForm" label-width="130px">
        <el-form-item :label="t('endpointRegistry.publicationBuilder.targetType')">
          <el-radio-group v-model="publicationTargetForm.type">
            <el-radio-button value="mcp_server">{{ filterLabel.mcp }}</el-radio-button>
            <el-radio-button value="gateway_service">{{ filterLabel.gateway }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.name')">
          <el-input v-model="publicationTargetForm.name" clearable />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.publicationBuilder.displayName')">
          <el-input v-model="publicationTargetForm.displayName" clearable />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.description')">
          <el-input v-model="publicationTargetForm.description" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.publicationBuilder.policyBindingRef')">
          <el-input v-model="publicationTargetForm.policyBindingRef" clearable />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="showPublicationTargetDialog = false">{{ t("common.cancel") }}</el-button>
          <el-button type="primary" :loading="publicationTargetSaving" @click="submitPublicationTargetForm">
            {{ publicationTargetSaving ? t("endpointRegistry.messages.submitting") : t("common.create") }}
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="showPublicationDialog"
      :title="publicationDialogTitle"
      width="720px"
      align-center
      @closed="resetPublicationForm"
    >
      <el-form :model="publicationForm" label-width="160px">
        <el-alert
          :title="publicationDialogHint"
          type="info"
          show-icon
          :closable="false"
          class="mb-12"
        />
        <el-alert
          v-if="selectedPublicationMembershipRow?.readinessState !== 'ready'"
          :title="t('endpointRegistry.publicationWorkbench.blockedTitle')"
          type="warning"
          show-icon
          :closable="false"
          class="mb-12"
        >
          <template #default>
            <ul class="publication-blocker-list">
              <li
                v-for="reason in selectedPublicationMembershipRow?.readinessReasons || []"
                :key="reason"
              >
                {{ reason }}
              </li>
            </ul>
          </template>
        </el-alert>
        <el-form-item :label="t('endpointRegistry.form.publicationRevision')">
          <el-input :model-value="String(publicationForm.publicationRevision || 0)" disabled />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.publishState')">
          <el-input :model-value="getPublicationStateLabel(publicationForm.publicationState || 'draft')" disabled />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.intentName')">
          <el-input v-model="publicationForm.intentName" clearable />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.descriptionForLlm')">
          <el-input v-model="publicationForm.descriptionForLlm" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.operatorNotes')">
          <el-input v-model="publicationForm.operatorNotes" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.visibility')">
          <el-select v-model="publicationForm.visibility" style="width: 100%">
            <el-option :label="t('endpointRegistry.options.visibility.internal')" value="internal" />
            <el-option :label="t('endpointRegistry.options.visibility.public')" value="public" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('endpointRegistry.form.profileStatus')">
          <el-select v-model="publicationForm.profileStatus" style="width: 100%">
            <el-option :label="t('endpointRegistry.options.profileStatus.draft')" value="draft" />
            <el-option :label="t('endpointRegistry.options.profileStatus.reviewed')" value="reviewed" />
            <el-option :label="t('endpointRegistry.options.profileStatus.published')" value="published" />
            <el-option :label="t('endpointRegistry.options.profileStatus.offline')" value="offline" />
          </el-select>
        </el-form-item>
        <el-divider content-position="left">{{ t("endpointRegistry.publicationWorkbench.checklistTitle") }}</el-divider>
        <div class="publication-checklist publication-dialog-checklist">
          <div
            v-for="item in getPublicationChecklist(selectedPublicationMembershipRow)"
            :key="item.key"
            class="publication-checklist-item"
          >
            <div class="publication-workbench-label">{{ item.label }}</div>
            <el-tag
              :type="item.applicable === false ? 'info' : item.passed ? 'success' : 'warning'"
              effect="plain"
            >
              {{
                item.applicable === false
                  ? t("endpointRegistry.publicationWorkbench.notApplicable")
                  : item.passed
                    ? t("endpointRegistry.publicationWorkbench.checkPassed")
                    : t("endpointRegistry.publicationWorkbench.checkBlocked")
              }}
            </el-tag>
          </div>
        </div>

        <template v-if="publicationRuntimeType === 'gateway_service'">
          <el-divider content-position="left">{{ t("endpointRegistry.gatewayRoute") }}</el-divider>
          <el-form-item :label="t('endpointRegistry.form.routePath')">
            <el-input v-model="publicationForm.routePath" clearable />
          </el-form-item>
          <el-form-item :label="t('endpointRegistry.form.routeMethod')">
            <el-select v-model="publicationForm.routeMethod" style="width: 100%">
              <el-option label="GET" value="GET" />
              <el-option label="POST" value="POST" />
              <el-option label="PUT" value="PUT" />
              <el-option label="PATCH" value="PATCH" />
              <el-option label="DELETE" value="DELETE" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('endpointRegistry.form.upstreamPath')">
            <el-input v-model="publicationForm.upstreamPath" clearable />
          </el-form-item>
          <el-form-item :label="t('endpointRegistry.form.upstreamMethod')">
            <el-select v-model="publicationForm.upstreamMethod" style="width: 100%">
              <el-option label="GET" value="GET" />
              <el-option label="POST" value="POST" />
              <el-option label="PUT" value="PUT" />
              <el-option label="PATCH" value="PATCH" />
              <el-option label="DELETE" value="DELETE" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('endpointRegistry.form.routeVisibility')">
            <el-select v-model="publicationForm.routeVisibility" style="width: 100%">
              <el-option :label="t('endpointRegistry.options.visibility.internal')" value="internal" />
              <el-option :label="t('endpointRegistry.options.visibility.public')" value="public" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('endpointRegistry.form.authPolicyRef')">
            <el-input v-model="publicationForm.authPolicyRef" clearable />
          </el-form-item>
          <el-form-item :label="t('endpointRegistry.form.trafficPolicyRef')">
            <el-input v-model="publicationForm.trafficPolicyRef" clearable />
          </el-form-item>
          <el-form-item :label="t('endpointRegistry.form.timeoutMs')">
            <el-input-number v-model="publicationForm.timeoutMs" :min="1" :step="100" style="width: 100%" />
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="showPublicationDialog = false">{{ t("common.cancel") }}</el-button>
          <el-button type="primary" :loading="publicationSaving" @click="submitPublicationForm">
            {{ publicationSaving ? t("common.updating") : t("endpointRegistry.actions.savePublicationConfig") }}
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="showTestDialog"
      :title="t('endpointRegistry.testDialog.title')"
      width="720px"
      align-center
      @closed="resetTestDialog"
    >
      <div v-loading="testDialogLoading" class="test-dialog-content">
        <el-alert
          v-if="testDialogError"
          :title="testDialogError"
          type="error"
          show-icon
          :closable="false"
          class="mb-12"
        />

        <template v-if="testDialogEndpoint">
          <div class="test-dialog-summary">
            <div class="test-dialog-title-row">
              <span class="group-name">{{ testDialogEndpoint.name }}</span>
              <el-tag type="info">{{ testDialogEndpoint.methodPath }}</el-tag>
            </div>
            <div class="manual-group-url">{{ testDialogEndpoint.baseUrl }}</div>
          </div>

          <el-row :gutter="12" class="mb-12">
            <el-col :xs="24" :md="8">
              <div class="test-state-card">
                <div class="test-state-label">{{ t("endpointRegistry.testDialog.testStatus") }}</div>
                <el-tag :type="getTestingTagType(testDialogEndpoint)">
                  {{ getTestingLabel(testDialogEndpoint) }}
                </el-tag>
              </div>
            </el-col>
            <el-col :xs="24" :md="8">
              <div class="test-state-card">
                <div class="test-state-label">{{ t("endpointRegistry.testDialog.httpStatus") }}</div>
                <div class="test-state-value">
                  {{ testDialogTestingState?.lastTestHttpStatus ?? "-" }}
                </div>
              </div>
            </el-col>
            <el-col :xs="24" :md="8">
              <div class="test-state-card">
                <div class="test-state-label">{{ t("endpointRegistry.testDialog.lastTestAt") }}</div>
                <div class="test-state-value">
                  {{ formatTestDialogTimestamp(testDialogTestingState?.lastTestAt) }}
                </div>
              </div>
            </el-col>
          </el-row>

          <el-form label-width="120px">
            <el-form-item :label="t('endpointRegistry.testDialog.parameters')">
              <el-input
                v-model="testDialogParametersText"
                type="textarea"
                :rows="8"
                :placeholder="t('endpointRegistry.testDialog.parametersPlaceholder')"
              />
            </el-form-item>
          </el-form>

          <el-alert
            v-if="testDialogTestingState?.lastTestError"
            :title="String(testDialogTestingState.lastTestError)"
            type="warning"
            show-icon
            :closable="false"
            class="mb-12"
          />

          <div v-if="testDialogResult" class="test-result-panel">
            <div class="test-state-label">{{ t("endpointRegistry.testDialog.result") }}</div>
            <pre class="test-result-pre">{{ testDialogResult }}</pre>
          </div>
        </template>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="showTestDialog = false">{{ t("common.cancel") }}</el-button>
          <el-button type="primary" :loading="testExecuting" @click="executeInlineEndpointTest">
            {{ testExecuting ? t("common.testing") : t("endpointRegistry.actions.test") }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { FormInstance } from "element-plus";
import type { ElTable } from "element-plus";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  Connection,
  CircleCheck,
  UploadFilled,
  SwitchButton,
  InfoFilled,
  Edit as EditIcon,
  Delete as DeleteIcon,
} from "@element-plus/icons-vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { runtimeAssetsAPI, serverAPI } from "@/services/api";
import {
  useOperationTimeline,
  type OperationTimelineEntry,
  type OperationTimelineLevel,
} from "@/composables/useOperationTimeline";
import OperationTimeline from "@/shared/components/ui/OperationTimeline.vue";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

type ProductSurface = "registration" | "governance" | "publication";
type RegistryFilter = "all" | "manual" | "imported" | "mcp" | "gateway";
type TestingStateFilter = "all" | "registered" | "tested" | "test_blocked";
type GovernanceReadinessFilter = "all" | "ready" | "blocked";

type EndpointRow = {
  id: string;
  serverId?: string;
  endpointDefinitionId?: string;
  sourceServiceAssetId?: string;
  runtimeMembershipId?: string;
  runtimeAssetId?: string;
  runtimeAssetType?: string;
  runtimeAssetName?: string;
  publicationRevision?: number;
  publicationProfileStatus?: string;
  routeConfigured?: boolean;
  publicationState?: string;
  publicationConfigSummary?: string;
  testStatus?: string;
  qualificationState?: string;
  testingSummary?: string;
  readinessState?: "ready" | "blocked";
  readinessReasons?: string[];
  readinessSummary?: string;
  name: string;
  baseUrl: string;
  groupName: string;
  endpointPath: string;
  methodPath: string;
  sourceType: "manual" | "imported";
  lifecycleStatus: string;
  publishEnabled: boolean;
  lastProbeStatus: string;
  lastProbeSummary: string;
  updatedAtText: string;
};

type EndpointAssetRecord = {
  id: string;
  sourceServiceAssetId: string;
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  status: string;
  publishEnabled: boolean;
  metadata?: Record<string, any>;
  updatedAt?: string;
};

type SourceServiceAssetRecord = {
  id: string;
  sourceKey: string;
  scheme: string;
  host: string;
  port: number;
  normalizedBasePath: string;
  displayName?: string;
  description?: string;
  metadata?: Record<string, any>;
  updatedAt?: string;
};

type PublicationMembershipRecord = {
  membership: {
    id: string;
    runtimeAssetId: string;
    endpointDefinitionId: string;
    status: string;
    publicationRevision: number;
    enabled: boolean;
    updatedAt?: string;
  };
  runtimeAsset: {
    id: string;
    name: string;
    type: string;
    status: string;
    displayName?: string;
    updatedAt?: string;
  };
  endpoint: {
    id: string;
    name: string;
  };
  endpointDefinition: {
    id: string;
    method: string;
    path: string;
    status: string;
  };
  profile?: {
    id?: string;
    intentName?: string;
    descriptionForLlm?: string;
    status?: string;
  };
  publishBinding?: {
    publishStatus?: string;
    publishedToMcp?: boolean;
    publishedToHttp?: boolean;
  };
  routeBinding?: {
    routePath?: string;
    routeMethod?: string;
    status?: string;
  } | null;
  readiness?: {
    ready: boolean;
    reasons: string[];
    routeConfigured?: boolean;
  };
};

type PublicationCandidateRecord = {
  endpointDefinition: EndpointAssetRecord;
  sourceServiceAsset?: SourceServiceAssetRecord | null;
  readiness: {
    ready: boolean;
    reasons: string[];
  };
  runtimeMemberships: Array<{
    membershipId: string;
    runtimeAssetId: string;
    runtimeAssetType: string;
    runtimeAssetName: string;
    membershipStatus: string;
    publicationRevision: number;
    enabled: boolean;
  }>;
};

type PublicationCandidateRow = {
  endpointDefinitionId: string;
  sourceServiceAssetId: string;
  groupKey: string;
  groupName: string;
  hostPort: string;
  basePath: string;
  name: string;
  methodPath: string;
  readinessState: "ready" | "blocked";
  readinessSummary: string;
  lifecycleStatus: string;
  lastProbeStatus: string;
  updatedAtText: string;
  runtimeTargetsSummary: string;
};

type PublicationCandidateGroup = {
  groupKey: string;
  groupName: string;
  hostPort: string;
  basePath: string;
  readyCount: number;
  blockedCount: number;
  endpoints: PublicationCandidateRow[];
};

type RuntimeAssetSummaryRecord = {
  asset: {
    id: string;
    type: string;
    status: string;
    name: string;
    displayName?: string;
  };
  runtimeSummary?: {
    runtimeStatus?: string;
    membershipCount?: number;
    activeMembershipCount?: number;
    publicationRevision?: number;
  };
  managedServer?: {
    id: string;
    status: string;
    endpoint?: string;
    healthy?: boolean;
  } | null;
  membershipCount?: number;
  activeMembershipCount?: number;
};

type Group = {
  groupKey: string;
  baseUrl: string;
  groupName: string;
  hostPort: string;
  basePath: string;
  testedCount: number;
  registeredCount: number;
  readyCount: number;
  blockedCount: number;
  activeCount: number;
  offlineCount: number;
  recentProbeStatus: string;
  endpoints: EndpointRow[];
};

type BatchPublicationRun = {
  id?: string;
  action: "publish" | "offline";
  status?: string;
  successCount: number;
  failedCount: number;
  runtimeAssetId?: string;
  runtimeAssetType?: string;
  at: string;
};

type PublicationAuditEventRecord = {
  id: string;
  action: string;
  status: "success" | "partial" | "failed" | "info";
  summary: string;
  details?: Record<string, unknown> | string;
  publicationBatchRunId?: string;
  runtimeAssetId?: string;
  runtimeAssetEndpointBindingId?: string;
  endpointDefinitionId?: string;
  sourceServiceAssetId?: string;
  operatorId?: string;
  createdAt: string;
};

const loading = ref(false);
const errorMessage = ref("");
const search = ref("");
const rows = ref<EndpointRow[]>([]);
const expandedGroupKeys = ref<string[]>([]);
const selectedFilter = ref<RegistryFilter>("all");
const selectedManualGroupKey = ref("");
const selectedGovernanceGroupKey = ref("");
const selectedPublicationGroupKey = ref("");
const selectedPublicationCandidateGroupKey = ref("");
const selectedPublicationMembershipRowId = ref("");
const selectedPublicationMembershipIds = ref<string[]>([]);
const selectedTestingState = ref<TestingStateFilter>("all");
const selectedReadinessState = ref<GovernanceReadinessFilter>("all");
const publicationCandidates = ref<PublicationCandidateRow[]>([]);
const selectedPublicationCandidateIds = ref<string[]>([]);
const publicationRuntimeAssets = ref<any[]>([]);
const selectedPublicationTargetType = ref<"mcp_server" | "gateway_service">("mcp_server");
const selectedPublicationTargetRuntimeAssetId = ref("");
const showPublicationTargetDialog = ref(false);
const publicationTargetSaving = ref(false);
const batchPublicationActionLoading = ref<"" | "publish" | "offline">("");
const publicationMembershipTableRef = ref<InstanceType<typeof ElTable> | null>(null);
const lastPublicationBatchRun = ref<BatchPublicationRun | null>(null);
const publicationAuditEvents = ref<PublicationAuditEventRecord[]>([]);
const actionLoading = ref<Record<string, string>>({});
const {
  entries: operationFeed,
  visible: operationFeedVisible,
  expanded: operationFeedExpanded,
  addEntry: pushOperationFeedEntry,
  clearEntries: clearOperationFeed,
} = useOperationTimeline(12);
const showCreateDialog = ref(false);
const creating = ref(false);
const testingFromDialog = ref(false);
const showTestDialog = ref(false);
const testDialogLoading = ref(false);
const testExecuting = ref(false);
const testDialogError = ref("");
const testDialogEndpointId = ref("");
const testDialogEndpoint = ref<EndpointRow | null>(null);
const testDialogTestingState = ref<Record<string, any> | null>(null);
const testDialogParametersText = ref("{}");
const testDialogResult = ref("");
const showPublicationDialog = ref(false);
const publicationSaving = ref(false);
type FormMode = "create" | "edit-manual" | "edit-imported";
const formMode = ref<FormMode>("create");
const editingRowId = ref("");
const publicationMembershipId = ref("");
const publicationRuntimeType = ref("");
const publicationTargetForm = ref({
  type: "mcp_server" as "mcp_server" | "gateway_service",
  name: "",
  displayName: "",
  description: "",
  policyBindingRef: "",
});
const createFormRef = ref<FormInstance>();
const createForm = ref({
  name: "",
  baseUrl: "",
  method: "GET",
  path: "",
  description: "",
  businessDomain: "",
  riskLevel: "medium",
  publishEnabled: false,
  probeUrl: "",
  governanceOwner: "",
  governanceNotes: "",
});
const publicationForm = ref({
  publicationRevision: 0,
  publicationState: "draft",
  intentName: "",
  descriptionForLlm: "",
  operatorNotes: "",
  visibility: "internal",
  profileStatus: "draft",
  routePath: "",
  routeMethod: "GET",
  upstreamPath: "",
  upstreamMethod: "GET",
  routeVisibility: "internal",
  authPolicyRef: "",
  trafficPolicyRef: "",
  timeoutMs: undefined as number | undefined,
});

const operationFeedLabels = computed(() => ({
  clear: t("endpointRegistry.operationFeed.clear"),
  hide: t("endpointRegistry.operationFeed.hide"),
  restore: t("endpointRegistry.operationFeed.restore"),
  collapse: t("endpointRegistry.operationFeed.collapse"),
  expand: t("endpointRegistry.operationFeed.expand"),
  levels: {
    success: t("endpointRegistry.operationFeed.levels.success"),
    warning: t("endpointRegistry.operationFeed.levels.warning"),
    error: t("endpointRegistry.operationFeed.levels.error"),
    info: t("endpointRegistry.operationFeed.levels.info"),
  },
}));

const currentSurface = computed<ProductSurface>(() => {
  const metaSurface = route.meta?.productSurface;
  if (
    metaSurface === "registration" ||
    metaSurface === "governance" ||
    metaSurface === "publication"
  ) {
    return metaSurface;
  }
  return "governance";
});

const pageTitle = computed(() => {
  switch (currentSurface.value) {
    case "registration":
      return route.path === "/registration/manual"
        ? t("endpointRegistry.surfaceTitle.manualRegistration")
        : t("endpointRegistry.surfaceTitle.apiRegistration");
    case "publication":
      return t("endpointRegistry.surfaceTitle.publication");
    case "governance":
    default:
      return t("endpointRegistry.surfaceTitle.governance");
  }
});

const isManualRegistrationView = computed(
  () => currentSurface.value === "registration" && route.path === "/registration/manual",
);
const isGovernanceCatalogView = computed(() => currentSurface.value === "governance");
const isPublicationCatalogView = computed(() => currentSurface.value === "publication");

const createButtonLabel = computed(() => t("endpointRegistry.actions.addManualEndpoint"));
const showCreateButton = computed(() => currentSurface.value === "registration");
const showProbeAction = computed(() => currentSurface.value === "governance");
const showTestAction = computed(
  () => currentSurface.value === "registration" || currentSurface.value === "governance",
);
const showReadinessAction = computed(
  () => currentSurface.value === "governance" || currentSurface.value === "publication",
);
const showPublishAction = computed(() => currentSurface.value === "publication");
const showOfflineAction = computed(() => currentSurface.value === "publication");
const showEditAction = computed(
  () =>
    currentSurface.value === "registration" ||
    currentSurface.value === "governance" ||
    currentSurface.value === "publication",
);
const showDeleteAction = computed(() => currentSurface.value === "registration");

const isImportedGovernanceEdit = computed(() => formMode.value === "edit-imported");
const isGovernanceEdit = computed(
  () => currentSurface.value === "governance" && formMode.value === "edit-imported",
);
const isEditMode = computed(() => formMode.value !== "create");

const createFormRules = computed(() => {
  const rules: Record<string, any[]> = {
    name: [
      {
        required: true,
        message: t("endpointRegistry.validation.nameRequired"),
        trigger: "blur",
      },
    ],
  };

  if (!isImportedGovernanceEdit.value) {
    rules.baseUrl = [
      {
        required: true,
        message: t("endpointRegistry.validation.baseUrlRequired"),
        trigger: "blur",
      },
      {
        type: "url",
        message: t("endpointRegistry.validation.baseUrlInvalid"),
        trigger: "blur",
      },
    ];
    rules.method = [
      {
        required: true,
        message: t("endpointRegistry.validation.methodRequired"),
        trigger: "change",
      },
    ];
    rules.path = [
      {
        required: true,
        message: t("endpointRegistry.validation.pathRequired"),
        trigger: "blur",
      },
      {
        validator: (_: unknown, value: string, callback: (err?: Error) => void) => {
          if (!value || value.startsWith("/")) {
            callback();
            return;
          }
          callback(new Error(t("endpointRegistry.validation.pathSlashRequired")));
        },
        trigger: "blur",
      },
    ];
  }

  return rules;
});

const isActionLoading = (
  rowId: string,
  action:
    | "probe"
    | "readiness"
    | "publish"
    | "offline"
    | "edit"
    | "delete"
    | "deploy"
    | "start"
    | "stop"
    | "redeploy",
) => actionLoading.value[rowId] === action;

const setActionLoading = (
  rowId: string,
  action:
    | "probe"
    | "readiness"
    | "publish"
    | "offline"
    | "edit"
    | "delete"
    | "deploy"
    | "start"
    | "stop"
    | "redeploy"
    | "",
) => {
  if (!action) {
    delete actionLoading.value[rowId];
    return;
  }
  actionLoading.value[rowId] = action;
};

const dialogTitle = computed(() => {
  if (isGovernanceEdit.value) {
    return t("endpointRegistry.dialog.governanceTitle");
  }
  if (formMode.value === "edit-imported") {
    return t("endpointRegistry.dialog.importedEditTitle");
  }
  if (formMode.value === "edit-manual") {
    return t("endpointRegistry.dialog.editTitle");
  }
  return t("endpointRegistry.dialog.title");
});

const publicationDialogTitle = computed(() =>
  publicationRuntimeType.value === "gateway_service"
    ? `${t("endpointRegistry.publicationDialog.gatewayTitle")}${publicationForm.value.publicationRevision ? t("endpointRegistry.publicationDialog.revisionSuffix", { revision: publicationForm.value.publicationRevision }) : ""}`
    : `${t("endpointRegistry.publicationDialog.mcpTitle")}${publicationForm.value.publicationRevision ? t("endpointRegistry.publicationDialog.revisionSuffix", { revision: publicationForm.value.publicationRevision }) : ""}`,
);

const publicationDialogHint = computed(() =>
  publicationRuntimeType.value === "gateway_service"
    ? t("endpointRegistry.publicationDialog.gatewayHint")
    : t("endpointRegistry.publicationDialog.mcpHint"),
);

const activeSubtitle = computed(() =>
  currentSurface.value === "registration"
    ? route.path === "/registration/manual"
      ? t("endpointRegistry.surfaceSubtitle.manualRegistration")
      : t("endpointRegistry.surfaceSubtitle.registration")
    : currentSurface.value === "publication"
      ? t("endpointRegistry.surfaceSubtitle.publication")
      : t("endpointRegistry.surfaceSubtitle.governance"),
);

const activeModeHint = computed(() =>
  currentSurface.value === "registration"
    ? route.path === "/registration/manual"
      ? t("endpointRegistry.surfaceModeHint.manualRegistration")
      : t("endpointRegistry.surfaceModeHint.registration")
    : currentSurface.value === "publication"
      ? t("endpointRegistry.surfaceModeHint.publication")
      : t("endpointRegistry.surfaceModeHint.governance"),
);

const filterLabel = computed(() => ({
  all: t("endpointRegistry.sourceTypes.all"),
  manual: t("endpointRegistry.sourceTypes.manual"),
  imported: t("endpointRegistry.sourceTypes.imported"),
  mcp: t("endpointRegistry.runtimeSource.mcp"),
  gateway: t("endpointRegistry.runtimeSource.gateway"),
}));

const probeDetailsLabel = computed(() => t("endpointRegistry.table.probeDetails"));

const getSourceLabel = (row: EndpointRow) => {
  if (currentSurface.value === "publication") {
    return row.runtimeAssetType === "gateway_service" ? filterLabel.value.gateway : filterLabel.value.mcp;
  }
  return row.sourceType === "manual" ? filterLabel.value.manual : filterLabel.value.imported;
};

const getSourceTagType = (row: EndpointRow) => {
  if (currentSurface.value === "publication") {
    return row.runtimeAssetType === "gateway_service" ? "success" : "primary";
  }
  return row.sourceType === "manual" ? "warning" : "primary";
};

const getTestingLabel = (row: EndpointRow) => {
  switch (row.qualificationState || row.testStatus) {
    case "tested":
      return t("endpointRegistry.testingState.tested");
    case "test_blocked":
      return t("endpointRegistry.testingState.testBlocked");
    case "registered":
    default:
      return t("endpointRegistry.testingState.registered");
  }
};

const getPublicationStateLabel = (status?: string) =>
  t(`endpointRegistry.options.publicationState.${status || "draft"}`);

const getPublicationStateTagType = (status?: string) => {
  switch (status) {
    case "active":
    case "published":
      return "success";
    case "ready":
    case "reviewed":
      return "primary";
    case "offline":
      return "warning";
    case "draft":
    default:
      return "info";
  }
};

const getProfileStatusLabel = (status?: string) =>
  t(`endpointRegistry.options.profileStatus.${status || "draft"}`);

const getProfileStatusTagType = (status?: string) => {
  switch (status) {
    case "published":
    case "reviewed":
      return "success";
    case "ready":
      return "primary";
    case "offline":
      return "warning";
    case "draft":
    default:
      return "info";
  }
};

const getTestingTagType = (row: EndpointRow) => {
  switch (row.qualificationState || row.testStatus) {
    case "tested":
      return "success";
    case "test_blocked":
      return "danger";
    case "registered":
    default:
      return "info";
  }
};

const getPublicationActionLabel = (row: EndpointRow) => {
  if (row.publicationState === "active") {
    return t("endpointRegistry.actions.republish");
  }
  if (row.publicationState === "offline") {
    return t("endpointRegistry.actions.activate");
  }
  return t("endpointRegistry.actions.publish");
};

const getOfflineActionLabel = (row: EndpointRow) => {
  if (row.publicationState === "active") {
    return t("endpointRegistry.actions.offline");
  }
  return t("endpointRegistry.actions.inactive");
};

const getPublicationFailureHint = (error: any) => {
  const message = String(error?.message || t("endpointRegistry.messages.publishFailed"));
  if (message.includes("gateway route binding is missing")) {
    return t("endpointRegistry.messages.targetConfigBlocked", { reason: message });
  }
  if (message.includes("profile status is")) {
    return t("endpointRegistry.messages.profileBlocked", { reason: message });
  }
  if (message.includes("intentName is empty") || message.includes("descriptionForLlm is empty")) {
    return t("endpointRegistry.messages.profileBlocked", { reason: message });
  }
  if (message.includes("endpoint testStatus is") || message.includes("testStatus is")) {
    return t("endpointRegistry.messages.readinessBlockedDetail", { reason: message });
  }
  if (message.includes("lastProbeStatus is") || message.includes("publishEnabled=false")) {
    return t("endpointRegistry.messages.governanceBlocked", { reason: message });
  }
  return message;
};

const getRouteConfigLabel = (row: EndpointRow) =>
  row.runtimeAssetType === "gateway_service"
    ? row.routeConfigured
      ? t("endpointRegistry.publicationWorkbench.routeConfigured")
      : t("endpointRegistry.publicationWorkbench.routeMissing")
    : t("endpointRegistry.publicationWorkbench.notApplicable");

const getRouteConfigTagType = (row: EndpointRow) =>
  row.runtimeAssetType === "gateway_service"
    ? row.routeConfigured
      ? "success"
      : "warning"
    : "info";

const getRuntimeStatusLabel = (status?: string) =>
  t(`endpointRegistry.runtimeStatus.${status || "draft"}`);

const getRuntimeStatusTagType = (status?: string) => {
  switch (status) {
    case "running":
    case "active":
      return "success";
    case "starting":
    case "stopping":
      return "warning";
    case "degraded":
    case "error":
      return "danger";
    case "offline":
      return "warning";
    case "draft":
    default:
      return "info";
  }
};

const getRuntimeAssetStatus = (runtimeAsset?: RuntimeAssetSummaryRecord | null) =>
  String(runtimeAsset?.runtimeSummary?.runtimeStatus || runtimeAsset?.asset?.status || "draft");

const getRuntimeAssetActiveMembershipCount = (
  runtimeAsset?: RuntimeAssetSummaryRecord | null,
) =>
  Number(
    runtimeAsset?.runtimeSummary?.activeMembershipCount ??
      runtimeAsset?.activeMembershipCount ??
      0,
  );

const hasRuntimeDeployment = (runtimeAsset?: RuntimeAssetSummaryRecord | null) => {
  if (!runtimeAsset) {
    return false;
  }
  if (runtimeAsset.asset.type === "gateway_service") {
    return getRuntimeAssetActiveMembershipCount(runtimeAsset) > 0;
  }
  return Boolean(runtimeAsset.managedServer?.id);
};

const isRuntimeActionDisabled = (
  action: "deploy" | "start" | "stop" | "redeploy",
  runtimeAsset?: RuntimeAssetSummaryRecord | null,
) => {
  if (!runtimeAsset) {
    return true;
  }

  const runtimeStatus = getRuntimeAssetStatus(runtimeAsset);
  const hasActiveMemberships = getRuntimeAssetActiveMembershipCount(runtimeAsset) > 0;
  const deployed = hasRuntimeDeployment(runtimeAsset);

  switch (action) {
    case "deploy":
    case "redeploy":
      return !hasActiveMemberships;
    case "start":
      if (["running", "active", "starting"].includes(runtimeStatus)) {
        return true;
      }
      if (!hasActiveMemberships) {
        return true;
      }
      return runtimeAsset.asset.type === "mcp_server" ? !deployed : false;
    case "stop":
      return !["running", "active"].includes(runtimeStatus);
    default:
      return false;
  }
};

const getRuntimeHandoffHint = (runtimeAsset?: RuntimeAssetSummaryRecord | null) => {
  if (!runtimeAsset) {
    return t("endpointRegistry.runtimeHandoff.hints.notReady");
  }

  const runtimeStatus = getRuntimeAssetStatus(runtimeAsset);
  const hasActiveMemberships = getRuntimeAssetActiveMembershipCount(runtimeAsset) > 0;
  const deployed = hasRuntimeDeployment(runtimeAsset);

  if (!hasActiveMemberships) {
    return t("endpointRegistry.runtimeHandoff.hints.publishFirst");
  }
  if (runtimeAsset.asset.type === "mcp_server" && !deployed) {
    return t("endpointRegistry.runtimeHandoff.hints.deployFirst");
  }
  if (["running", "active"].includes(runtimeStatus)) {
    return t("endpointRegistry.runtimeHandoff.hints.running");
  }
  return t("endpointRegistry.runtimeHandoff.hints.ready");
};

type PublicationFlowStageState = "done" | "current" | "pending" | "blocked";

const getPublicationFlowStageTagType = (status: PublicationFlowStageState) => {
  switch (status) {
    case "done":
      return "success";
    case "current":
      return "primary";
    case "blocked":
      return "danger";
    case "pending":
    default:
      return "info";
  }
};

const getPublicationFlowStageStatusLabel = (status: PublicationFlowStageState) =>
  t(`endpointRegistry.publicationFlow.status.${status}`);

const getPublicationFlowStages = (
  row?: EndpointRow | null,
  runtimeAsset?: RuntimeAssetSummaryRecord | null,
) => {
  if (!row) {
    return [];
  }

  const runtimeStatus = getRuntimeAssetStatus(runtimeAsset);
  const deployed = hasRuntimeDeployment(runtimeAsset);
  const published = row.publicationState === "active";

  return [
    {
      key: "ready",
      label: t("endpointRegistry.publicationFlow.steps.ready"),
      status: (row.readinessState === "ready" ? "done" : "blocked") as PublicationFlowStageState,
      hint:
        row.readinessState === "ready"
          ? t("endpointRegistry.publicationFlow.hints.readyDone")
          : t("endpointRegistry.publicationFlow.hints.readyBlocked"),
    },
    {
      key: "published",
      label: t("endpointRegistry.publicationFlow.steps.published"),
      status: (
        published
          ? "done"
          : row.readinessState === "ready"
            ? "current"
            : "pending"
      ) as PublicationFlowStageState,
      hint: published
        ? t("endpointRegistry.publicationFlow.hints.publishedDone")
        : row.readinessState === "ready"
          ? t("endpointRegistry.publicationFlow.hints.publishedCurrent")
          : t("endpointRegistry.publicationFlow.hints.publishedPending"),
    },
    {
      key: "deployed",
      label: t("endpointRegistry.publicationFlow.steps.deployed"),
      status: (
        deployed
          ? "done"
          : published
            ? "current"
            : "pending"
      ) as PublicationFlowStageState,
      hint: deployed
        ? t("endpointRegistry.publicationFlow.hints.deployedDone")
        : published
          ? t("endpointRegistry.publicationFlow.hints.deployedCurrent")
          : t("endpointRegistry.publicationFlow.hints.deployedPending"),
    },
    {
      key: "active",
      label: t("endpointRegistry.publicationFlow.steps.active"),
      status: (
        ["running", "active"].includes(runtimeStatus)
          ? "done"
          : deployed
            ? "current"
            : "pending"
      ) as PublicationFlowStageState,
      hint: ["running", "active"].includes(runtimeStatus)
        ? t("endpointRegistry.publicationFlow.hints.activeDone")
        : deployed
          ? t("endpointRegistry.publicationFlow.hints.activeCurrent")
          : t("endpointRegistry.publicationFlow.hints.activePending"),
    },
  ];
};

const getPublicationNextStepHint = (
  row?: EndpointRow | null,
  runtimeAsset?: RuntimeAssetSummaryRecord | null,
) => {
  if (!row) {
    return "-";
  }
  if (row.readinessState !== "ready") {
    return t("endpointRegistry.publicationFlow.next.resolveGovernance");
  }
  if (row.publicationState !== "active") {
    return t("endpointRegistry.publicationFlow.next.publishMembership");
  }
  if (!hasRuntimeDeployment(runtimeAsset)) {
    return t("endpointRegistry.publicationFlow.next.deployRuntime");
  }
  if (!["running", "active"].includes(getRuntimeAssetStatus(runtimeAsset))) {
    return t("endpointRegistry.publicationFlow.next.startRuntime");
  }
  return t("endpointRegistry.publicationFlow.next.observeRuntime");
};

const classifyPublicationReason = (reason: string) => {
  if (
    reason.includes("profile status") ||
    reason.includes("intentName") ||
    reason.includes("descriptionForLlm")
  ) {
    return "profile";
  }
  if (reason.includes("route")) {
    return "route";
  }
  return "governance";
};

const getPublicationBlockerGroups = (row?: EndpointRow | null) => {
  const groups: Array<{ key: "governance" | "profile" | "route"; reasons: string[] }> = [];
  const bucket = new Map<"governance" | "profile" | "route", string[]>();
  for (const reason of row?.readinessReasons || []) {
    const key = classifyPublicationReason(reason);
    const list = bucket.get(key) || [];
    list.push(reason);
    bucket.set(key, list);
  }
  for (const key of ["governance", "profile", "route"] as const) {
    const reasons = bucket.get(key) || [];
    if (reasons.length > 0) {
      groups.push({ key, reasons });
    }
  }
  return groups;
};

const getPublicationBlockerGroupLabel = (key: "governance" | "profile" | "route") =>
  t(`endpointRegistry.publicationWorkbench.blockerGroups.${key}`);

const getPublicationChecklist = (row?: EndpointRow | null) => {
  if (!row) {
    return [];
  }
  return [
    {
      key: "governance",
      label: t("endpointRegistry.publicationWorkbench.checks.governance"),
      passed: row.lifecycleStatus === "verified" || row.lifecycleStatus === "published" || row.lifecycleStatus === "offline",
    },
    {
      key: "probe",
      label: t("endpointRegistry.publicationWorkbench.checks.probe"),
      passed: row.lastProbeStatus === "healthy",
    },
    {
      key: "profile",
      label: t("endpointRegistry.publicationWorkbench.checks.profile"),
      passed:
        row.publicationProfileStatus === "reviewed" ||
        row.publicationProfileStatus === "published",
    },
    {
      key: "route",
      label: t("endpointRegistry.publicationWorkbench.checks.route"),
      passed: row.runtimeAssetType === "gateway_service" ? Boolean(row.routeConfigured) : true,
      applicable: row.runtimeAssetType === "gateway_service",
    },
    {
      key: "publish",
      label: t("endpointRegistry.publicationWorkbench.checks.publish"),
      passed: row.readinessState === "ready",
    },
  ];
};

const deriveGovernanceReadiness = (input: {
  lifecycleStatus?: string;
  publishEnabled?: boolean;
  lastProbeStatus?: string;
  testStatus?: string;
}) => {
  const reasons: string[] = [];

  if (
    input.lifecycleStatus !== "verified" &&
    input.lifecycleStatus !== "published" &&
    input.lifecycleStatus !== "offline"
  ) {
    reasons.push(
      t("endpointRegistry.messages.reasonLifecycle", {
        actual: getLifecycleLabel(String(input.lifecycleStatus || "draft")),
      }),
    );
  }
  if (!input.publishEnabled && input.lifecycleStatus !== "offline") {
    reasons.push(t("endpointRegistry.messages.reasonPublishDisabled"));
  }
  if (input.lastProbeStatus !== "healthy") {
    reasons.push(
      t("endpointRegistry.messages.reasonProbeStatus", {
        actual: getProbeLabel(String(input.lastProbeStatus || "unknown")),
      }),
    );
  }
  if (input.testStatus !== "passed") {
    reasons.push(
      t("endpointRegistry.messages.reasonTestStatus", {
        actual: getTestingLabel({
          qualificationState: String(input.testStatus || "registered"),
          testStatus: String(input.testStatus || "registered"),
        } as EndpointRow),
      }),
    );
  }

  return {
    readinessState: reasons.length === 0 ? "ready" : "blocked",
    readinessReasons: reasons,
    readinessSummary:
      reasons.length === 0
        ? t("endpointRegistry.messages.governanceReadinessPassed")
        : reasons.join("; "),
  } as const;
};

const requirePublicationMembershipRow = (row: EndpointRow) => {
  if (!row.runtimeMembershipId) {
    throw new Error("This action is not available before runtime membership creation.");
  }
  return row.runtimeMembershipId;
};

const openCreateDialog = () => {
  resetCreateForm();
  formMode.value = "create";
  showCreateDialog.value = true;
};

const normalizeBaseUrl = (url?: string) => {
  if (!url) return "unknown";
  return url.trim().replace(/\/+$/, "").toLowerCase();
};

const buildProbeUrl = (baseUrl: string, path: string) => {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
};

const parseGroupLocation = (baseUrl: string) => {
  try {
    const parsed = new URL(baseUrl);
    return {
      hostPort: parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname,
      basePath: parsed.pathname || "/",
    };
  } catch {
    return {
      hostPort: baseUrl,
      basePath: "/",
    };
  }
};

const deriveBaseUrlFromAsset = (asset?: SourceServiceAssetRecord) => {
  if (!asset) return "unknown";
  const isDefaultPort =
    (asset.scheme === "http" && asset.port === 80) ||
    (asset.scheme === "https" && asset.port === 443);
  const authority = isDefaultPort
    ? `${asset.scheme}://${asset.host}`
    : `${asset.scheme}://${asset.host}:${asset.port}`;
  return asset.normalizedBasePath === "/" ? authority : `${authority}${asset.normalizedBasePath}`;
};

const getLifecycleLabel = (status?: string) =>
  t(`endpointRegistry.lifecycleStatus.${status || "draft"}`);

const getLifecycleTagType = (status?: string) => {
  switch (status) {
    case "published":
      return "success";
    case "verified":
      return "primary";
    case "degraded":
      return "danger";
    case "offline":
      return "warning";
    case "retired":
      return "info";
    case "draft":
    default:
      return "info";
  }
};

const getProbeLabel = (status?: string) =>
  t(`endpointRegistry.probeStatus.${status || "unknown"}`);

const getProbeTagType = (status?: string) => {
  switch (status) {
    case "healthy":
      return "success";
    case "unhealthy":
      return "danger";
    case "unknown":
    default:
      return "info";
  }
};

const isValidationLikeProbe = (httpStatus?: number) =>
  [400, 401, 403, 405, 409, 415, 422, 429].includes(Number(httpStatus));

const formatProbeSummary = ({
  probeStatus,
  httpStatus,
  errorMessage,
}: {
  probeStatus?: string;
  httpStatus?: number;
  errorMessage?: string;
}) => {
  const normalizedStatus = probeStatus || "unknown";

  if (normalizedStatus === "healthy" && isValidationLikeProbe(httpStatus)) {
    return t("endpointRegistry.probeSummary.validationLikeHealthy", {
      httpStatus,
      details: errorMessage
        ? ` ${t("endpointRegistry.probeSummary.detailsPrefix", { error: errorMessage })}`
        : "",
    });
  }

  if (normalizedStatus === "healthy") {
    return t("endpointRegistry.probeSummary.healthy", {
      suffix: httpStatus ? ` (HTTP ${httpStatus})` : "",
    });
  }

  if (normalizedStatus === "unhealthy") {
    return t("endpointRegistry.probeSummary.unhealthy", {
      suffix: httpStatus ? ` (HTTP ${httpStatus})` : "",
      details: errorMessage ? `: ${errorMessage}` : "",
    });
  }

  return t("endpointRegistry.probeSummary.unknown");
};

const formatProbeFeedback = (result: {
  probe?: {
    status?: string;
    httpStatus?: number;
    errorMessage?: string;
  };
}) => {
  const probeStatus = result?.probe?.status || "unknown";
  const httpStatus = result?.probe?.httpStatus;
  const errorMessage = result?.probe?.errorMessage;

  if (probeStatus === "healthy" || probeStatus === "unhealthy") {
    return formatProbeSummary({
      probeStatus,
      httpStatus,
      errorMessage,
    });
  }

  return t("endpointRegistry.messages.probeFinished", { status: probeStatus });
};

const withGovernanceScopeHint = (message: string, row: EndpointRow, probeStatus?: string) =>
  row.sourceType === "imported" && probeStatus !== "unknown"
    ? `${message} ${t("endpointRegistry.messages.importedScopeSuffix")}`
    : message;


const mapRegistrationAssetRow = (
  endpoint: EndpointAssetRecord,
  sourceServiceAsset?: SourceServiceAssetRecord,
): EndpointRow => {
  const metadata = (endpoint.metadata || {}) as Record<string, any>;
  const sourceType =
    metadata.source === "manual-registration" ? "manual" : "imported";
  const displayName = String(
    metadata.displayName ||
      sourceServiceAsset?.displayName ||
      endpoint.summary ||
      endpoint.path,
  ).trim();
  const baseUrl = deriveBaseUrlFromAsset(sourceServiceAsset);
  const readiness = deriveGovernanceReadiness({
    lifecycleStatus: endpoint.status || "draft",
    publishEnabled: Boolean(endpoint.publishEnabled),
    lastProbeStatus: String(metadata.lastProbeStatus || "unknown"),
    testStatus: metadata.testStatus === "passed" ? "passed" : String(metadata.testStatus || "untested"),
  });

  return {
    id: endpoint.id,
    endpointDefinitionId: endpoint.id,
    sourceServiceAssetId: endpoint.sourceServiceAssetId,
    testStatus: String(metadata.testStatus || "untested"),
    qualificationState: String(metadata.qualificationState || "registered"),
    testingSummary:
      metadata.testStatus === "passed"
        ? t("endpointRegistry.messages.functionalTestPassed", {
            suffix: metadata.lastTestHttpStatus ? ` (HTTP ${metadata.lastTestHttpStatus})` : "",
          })
        : metadata.lastTestError
          ? String(metadata.lastTestError)
          : t("endpointRegistry.messages.noSuccessfulFunctionalTest"),
    name: displayName || endpoint.path,
    baseUrl,
    groupName: sourceServiceAsset?.displayName || displayName || baseUrl,
    endpointPath: endpoint.path,
    methodPath: `${endpoint.method} ${endpoint.path}`,
    sourceType,
    lifecycleStatus: endpoint.status || "draft",
    publishEnabled: Boolean(endpoint.publishEnabled),
    lastProbeStatus: String(metadata.lastProbeStatus || "unknown"),
    lastProbeSummary: formatProbeSummary({
      probeStatus: metadata.lastProbeStatus,
      httpStatus: metadata.lastProbeHttpStatus,
      errorMessage: metadata.lastProbeError,
    }),
    readinessState: readiness.readinessState,
    readinessReasons: readiness.readinessReasons,
    readinessSummary: readiness.readinessSummary,
    updatedAtText: endpoint.updatedAt ? new Date(endpoint.updatedAt).toLocaleString() : "-",
  };
};

const mapPublicationMembershipRow = (item: PublicationMembershipRecord): EndpointRow => {
  const runtimeType = item.runtimeAsset?.type || "runtime";
  const runtimeLabel =
    runtimeType === "mcp_server"
      ? t("endpointRegistry.runtimeSource.mcp")
      : runtimeType === "gateway_service"
        ? t("endpointRegistry.runtimeSource.gateway")
        : runtimeType;
  const routeSummary =
    item.routeBinding?.routePath && item.routeBinding?.routeMethod
      ? `${item.routeBinding.routeMethod} ${item.routeBinding.routePath}`
      : "";
  const publishEnabled = Boolean(
    runtimeType === "mcp_server"
      ? item.publishBinding?.publishedToMcp
      : item.publishBinding?.publishedToHttp,
  );
  const publicationState = String(item.publishBinding?.publishStatus || item.membership.status || "draft");
  const publicationConfigSummary =
    runtimeType === "gateway_service"
      ? [
          item.profile?.status
            ? t("endpointRegistry.publicationConfig.profile", {
                status: getProfileStatusLabel(item.profile.status),
              })
            : t("endpointRegistry.publicationConfig.profileDraft"),
          item.routeBinding?.routePath && item.routeBinding?.routeMethod
            ? t("endpointRegistry.publicationConfig.route", {
                method: item.routeBinding.routeMethod,
                path: item.routeBinding.routePath,
              })
            : t("endpointRegistry.publicationConfig.routeMissing"),
        ].join("; ")
      : item.profile?.status
        ? t("endpointRegistry.publicationConfig.profile", {
            status: getProfileStatusLabel(item.profile.status),
          })
        : t("endpointRegistry.publicationConfig.profileDraft");

  return {
    id: item.membership.id,
    runtimeMembershipId: item.membership.id,
    runtimeAssetId: item.runtimeAsset.id,
    runtimeAssetType: runtimeType,
    runtimeAssetName: item.runtimeAsset.displayName || item.runtimeAsset.name,
    publicationRevision: item.membership.publicationRevision || 0,
    publicationProfileStatus: item.profile?.status || "draft",
    routeConfigured: Boolean(item.readiness?.routeConfigured),
    endpointDefinitionId: item.endpointDefinition.id,
    name: item.profile?.intentName || item.endpoint.name,
    baseUrl: runtimeLabel,
    groupName: item.runtimeAsset.displayName || item.runtimeAsset.name || runtimeLabel,
    endpointPath: item.endpointDefinition.path,
    methodPath: routeSummary || `${item.endpointDefinition.method} ${item.endpointDefinition.path}`,
    sourceType: "imported",
    lifecycleStatus:
      item.publishBinding?.publishStatus || item.membership.status || item.endpointDefinition.status || "draft",
    publicationState,
    publicationConfigSummary,
    publishEnabled,
    lastProbeStatus: item.readiness?.ready ? "healthy" : "unhealthy",
    lastProbeSummary: item.readiness?.ready
      ? t("endpointRegistry.messages.publicationReadinessPassed")
      : (item.readiness?.reasons || []).join("; ") || t("endpointRegistry.messages.publicationReadinessPending"),
    readinessState: item.readiness?.ready ? "ready" : "blocked",
    readinessReasons: item.readiness?.reasons || [],
    readinessSummary: item.readiness?.ready
      ? t("endpointRegistry.messages.publicationReadinessPassed")
      : (item.readiness?.reasons || []).join("; ") || t("endpointRegistry.messages.publicationReadinessPending"),
    updatedAtText: item.membership.updatedAt
      ? new Date(item.membership.updatedAt).toLocaleString()
      : item.runtimeAsset.updatedAt
        ? new Date(item.runtimeAsset.updatedAt).toLocaleString()
        : "-",
  };
};

const grouped = computed<Group[]>(() => {
  const map = new Map<string, Group>();
  for (const row of rows.value) {
    const groupKey =
      currentSurface.value === "publication"
        ? row.runtimeAssetId || `${row.groupName}::${row.baseUrl}`
        : row.sourceServiceAssetId || row.serverId || `${row.groupName}::${row.baseUrl}`;
    if (!map.has(groupKey)) {
      const location = parseGroupLocation(row.baseUrl);
      map.set(groupKey, {
        groupKey,
        baseUrl: row.baseUrl,
        groupName: row.groupName,
        hostPort: location.hostPort,
        basePath: location.basePath,
        testedCount: 0,
        registeredCount: 0,
        readyCount: 0,
        blockedCount: 0,
        activeCount: 0,
        offlineCount: 0,
        recentProbeStatus: "unknown",
        endpoints: [],
      });
    }
    map.get(groupKey)!.endpoints.push(row);
  }
  return Array.from(map.values())
    .map((group) => ({
      ...group,
      endpoints: group.endpoints.sort((a, b) => a.methodPath.localeCompare(b.methodPath)),
      testedCount: group.endpoints.filter((row) => (row.qualificationState || row.testStatus) === "tested").length,
      registeredCount: group.endpoints.filter((row) => (row.qualificationState || row.testStatus) === "registered").length,
      readyCount: group.endpoints.filter((row) => row.readinessState === "ready").length,
      blockedCount: group.endpoints.filter((row) => row.readinessState === "blocked").length,
      activeCount: group.endpoints.filter((row) => row.publicationState === "active").length,
      offlineCount: group.endpoints.filter((row) => row.publicationState === "offline").length,
      recentProbeStatus: group.endpoints.some((row) => row.lastProbeStatus === "unhealthy")
        ? "unhealthy"
        : group.endpoints.some((row) => row.lastProbeStatus === "healthy")
          ? "healthy"
          : "unknown",
    }))
    .sort((a, b) =>
      `${a.groupName} ${a.baseUrl}`.localeCompare(`${b.groupName} ${b.baseUrl}`),
    );
});

const filteredGroups = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return grouped.value;
  return grouped.value
    .map((group) => ({
      ...group,
      endpoints: group.endpoints.filter(
        (ep) =>
          ep.baseUrl.includes(q) ||
          ep.name.toLowerCase().includes(q) ||
          ep.methodPath.toLowerCase().includes(q),
      ),
    }))
    .filter((group) => group.endpoints.length > 0);
});

const showSurfaceEmptyState = computed(() => {
  if (loading.value) {
    return false;
  }
  if (isPublicationCatalogView.value) {
    return (
      filteredGroups.value.length === 0 &&
      publicationCandidateGroups.value.length === 0
    );
  }
  return filteredGroups.value.length === 0;
});

const manualVisibleGroups = computed(() => filteredGroups.value);
const governanceVisibleGroups = computed(() => filteredGroups.value);
const publicationVisibleGroups = computed(() => filteredGroups.value);

const effectiveSelectedManualGroupKey = computed(() => {
  if (
    selectedManualGroupKey.value &&
    manualVisibleGroups.value.some((group) => group.groupKey === selectedManualGroupKey.value)
  ) {
    return selectedManualGroupKey.value;
  }
  return manualVisibleGroups.value[0]?.groupKey || "";
});

const selectedManualGroup = computed(
  () =>
    manualVisibleGroups.value.find(
      (group) => group.groupKey === effectiveSelectedManualGroupKey.value,
    ) || null,
);
const effectiveSelectedGovernanceGroupKey = computed(() => {
  if (
    selectedGovernanceGroupKey.value &&
    governanceVisibleGroups.value.some((group) => group.groupKey === selectedGovernanceGroupKey.value)
  ) {
    return selectedGovernanceGroupKey.value;
  }
  return governanceVisibleGroups.value[0]?.groupKey || "";
});

const selectedGovernanceGroup = computed(
  () =>
    governanceVisibleGroups.value.find(
      (group) => group.groupKey === effectiveSelectedGovernanceGroupKey.value,
    ) || null,
);
const effectiveSelectedPublicationGroupKey = computed(() => {
  if (
    selectedPublicationGroupKey.value &&
    publicationVisibleGroups.value.some((group) => group.groupKey === selectedPublicationGroupKey.value)
  ) {
    return selectedPublicationGroupKey.value;
  }
  return publicationVisibleGroups.value[0]?.groupKey || "";
});

const selectedPublicationGroup = computed(
  () =>
    publicationVisibleGroups.value.find(
      (group) => group.groupKey === effectiveSelectedPublicationGroupKey.value,
    ) || null,
);
const effectiveSelectedPublicationMembershipRowId = computed(() => {
  if (
    selectedPublicationMembershipRowId.value &&
    selectedPublicationGroup.value?.endpoints.some(
      row => row.id === selectedPublicationMembershipRowId.value,
    )
  ) {
    return selectedPublicationMembershipRowId.value;
  }
  return selectedPublicationGroup.value?.endpoints[0]?.id || "";
});

const selectedPublicationMembershipRow = computed(
  () =>
    selectedPublicationGroup.value?.endpoints.find(
      row => row.id === effectiveSelectedPublicationMembershipRowId.value,
    ) || null,
);

const selectedPublicationMembershipRows = computed(() =>
  (selectedPublicationGroup.value?.endpoints || []).filter(row =>
    selectedPublicationMembershipIds.value.includes(row.id),
  ),
);

const batchPublicationPublishableCount = computed(
  () =>
    selectedPublicationMembershipRows.value.filter(
      row => row.readinessState === "ready" && row.publicationState !== "active",
    ).length,
);

const batchPublicationOfflineableCount = computed(
  () =>
    selectedPublicationMembershipRows.value.filter(
      row => row.publicationState === "active",
    ).length,
);

const publicationActivityEntries = computed<OperationTimelineEntry[]>(() => {
  if (publicationAuditEvents.value.length > 0) {
    return publicationAuditEvents.value.map(event => ({
      id: event.id,
      level: (
        event.status === "failed"
          ? "error"
          : event.status === "partial"
            ? "warning"
            : event.status === "success"
              ? "success"
              : "info"
      ) as OperationTimelineLevel,
      title: event.summary,
      summary: event.action,
      details:
        typeof event.details === "string"
          ? event.details
          : event.details
            ? JSON.stringify(event.details)
            : undefined,
      timestamp: event.createdAt,
    }));
  }
  const runtimeAssetId =
    selectedPublicationGroup.value?.groupKey || selectedPublicationRuntimeAsset.value?.asset.id;
  const selectedMethodPaths = new Set(
    selectedPublicationGroup.value?.endpoints.map(row => row.methodPath) || [],
  );
  return operationFeed.value.filter(entry => {
    const haystack = `${entry.title} ${entry.summary} ${entry.details || ""}`;
    if (runtimeAssetId && haystack.includes(runtimeAssetId)) {
      return true;
    }
    for (const methodPath of selectedMethodPaths) {
      if (haystack.includes(methodPath)) {
        return true;
      }
    }
    return false;
  });
});

const publicationCandidateGroups = computed<PublicationCandidateGroup[]>(() => {
  const map = new Map<string, PublicationCandidateGroup>();
  for (const row of publicationCandidates.value) {
    if (!map.has(row.groupKey)) {
      map.set(row.groupKey, {
        groupKey: row.groupKey,
        groupName: row.groupName,
        hostPort: row.hostPort,
        basePath: row.basePath,
        readyCount: 0,
        blockedCount: 0,
        endpoints: [],
      });
    }
    map.get(row.groupKey)!.endpoints.push(row);
  }

  return Array.from(map.values())
    .map(group => ({
      ...group,
      endpoints: group.endpoints.sort((a, b) => a.methodPath.localeCompare(b.methodPath)),
      readyCount: group.endpoints.filter(item => item.readinessState === "ready").length,
      blockedCount: group.endpoints.filter(item => item.readinessState === "blocked").length,
    }))
    .sort((a, b) => `${a.groupName} ${a.hostPort}`.localeCompare(`${b.groupName} ${b.hostPort}`));
});

const effectiveSelectedPublicationCandidateGroupKey = computed(() => {
  if (
    selectedPublicationCandidateGroupKey.value &&
    publicationCandidateGroups.value.some(
      group => group.groupKey === selectedPublicationCandidateGroupKey.value,
    )
  ) {
    return selectedPublicationCandidateGroupKey.value;
  }
  return publicationCandidateGroups.value[0]?.groupKey || "";
});

const selectedPublicationCandidateGroup = computed(
  () =>
    publicationCandidateGroups.value.find(
      group => group.groupKey === effectiveSelectedPublicationCandidateGroupKey.value,
    ) || null,
);

const publicationTargetOptions = computed(() =>
  publicationRuntimeAssets.value.filter(
    item => item.asset?.type === selectedPublicationTargetType.value,
  ),
);

const runtimeAssetMap = computed(
  () =>
    new Map(
      (publicationRuntimeAssets.value as RuntimeAssetSummaryRecord[]).map(item => [
        item.asset.id,
        item,
      ]),
    ),
);

const selectedPublicationTargetAsset = computed(
  () =>
    publicationTargetOptions.value.find(
      item => item.asset?.id === selectedPublicationTargetRuntimeAssetId.value,
    ) || null,
);

const selectedPublicationRuntimeAsset = computed(() => {
  const runtimeAssetId = selectedPublicationMembershipRow.value?.runtimeAssetId;
  if (!runtimeAssetId) {
    return null;
  }
  return runtimeAssetMap.value.get(runtimeAssetId) || null;
});

const actionColumnWidth = computed(() => {
  if (isManualRegistrationView.value) return 380;
  if (currentSurface.value === "governance") return 430;
  if (currentSurface.value === "publication") return 620;
  return 420;
});

const loadOverview = async () => {
  loading.value = true;
  errorMessage.value = "";
  try {
    if (currentSurface.value === "publication") {
      const [candidateResult, membershipResult, runtimeAssetResult] = await Promise.all([
        serverAPI.listPublicationCandidates({
          search: search.value.trim() || undefined,
          includeBlocked: true,
        }),
        serverAPI.listPublicationRuntimeMemberships(),
        runtimeAssetsAPI.listRuntimeAssets(),
      ]);
      const candidateData: PublicationCandidateRecord[] = Array.isArray(candidateResult?.data)
        ? (candidateResult.data as PublicationCandidateRecord[])
        : [];
      publicationCandidates.value = candidateData.map(item => mapPublicationCandidateRow(item));
      const data: PublicationMembershipRecord[] = Array.isArray(membershipResult?.data)
        ? (membershipResult.data as PublicationMembershipRecord[])
        : [];
      publicationRuntimeAssets.value = Array.isArray(runtimeAssetResult?.data)
        ? runtimeAssetResult.data
        : [];
      rows.value = data
        .map((item: PublicationMembershipRecord) => mapPublicationMembershipRow(item))
        .filter((row: EndpointRow) => {
          const sourceMatches =
            selectedFilter.value === "all"
              ? true
              : selectedFilter.value === "mcp"
                ? row.runtimeAssetType === "mcp_server"
                : selectedFilter.value === "gateway"
                  ? row.runtimeAssetType === "gateway_service"
                  : true;
          const readinessMatches =
            selectedReadinessState.value === "all"
              ? true
              : (row.readinessState || "blocked") === selectedReadinessState.value;
          const searchValue = search.value.trim().toLowerCase();
          const searchMatches = !searchValue
            ? true
            : [row.name, row.groupName, row.methodPath, row.baseUrl]
                .filter(Boolean)
                .some((value) => String(value).toLowerCase().includes(searchValue));
          return sourceMatches && readinessMatches && searchMatches;
        });
      expandedGroupKeys.value = grouped.value.map((g) => g.groupKey);
      if (
        !selectedPublicationTargetRuntimeAssetId.value &&
        publicationTargetOptions.value.length > 0
      ) {
        selectedPublicationTargetRuntimeAssetId.value = publicationTargetOptions.value[0].asset.id;
      }
      await loadPublicationAuditTrail();
      return;
    }

    publicationCandidates.value = [];
    publicationRuntimeAssets.value = [];
    publicationAuditEvents.value = [];
    const [endpointResult, sourceServiceResult] = await Promise.all([
      serverAPI.listEndpointAssets({
        search: search.value.trim() || undefined,
      }),
      serverAPI.listSourceServiceAssets(),
    ]);
    const sourceServiceData: SourceServiceAssetRecord[] = Array.isArray(sourceServiceResult?.data)
      ? (sourceServiceResult.data as SourceServiceAssetRecord[])
      : [];
    const sourceAssets = new Map<string, SourceServiceAssetRecord>(
      sourceServiceData.map((item: SourceServiceAssetRecord) => [item.id, item]),
    );
    const endpointData: EndpointAssetRecord[] = Array.isArray(endpointResult?.data)
      ? (endpointResult.data as EndpointAssetRecord[])
      : [];
    rows.value = endpointData
      .map((item: EndpointAssetRecord) =>
        mapRegistrationAssetRow(item, sourceAssets.get(item.sourceServiceAssetId)),
      )
      .filter((row: EndpointRow) => {
        const sourceMatches =
          isManualRegistrationView.value
            ? row.sourceType === "manual"
            : selectedFilter.value === "all"
              ? true
              : row.sourceType === selectedFilter.value;
        const testingMatches =
          currentSurface.value !== "governance" || selectedTestingState.value === "all"
            ? true
            : (row.qualificationState || "registered") === selectedTestingState.value;
        const readinessMatches =
          currentSurface.value !== "governance" || selectedReadinessState.value === "all"
            ? true
            : (row.readinessState || "blocked") === selectedReadinessState.value;
        return sourceMatches && testingMatches && readinessMatches;
      });
    expandedGroupKeys.value = grouped.value.map((g) => g.groupKey);
  } catch (error: any) {
    rows.value = [];
    errorMessage.value =
      error?.message || t("endpointRegistry.messages.loadFailed");
  } finally {
    loading.value = false;
  }
};

const loadPublicationAuditTrail = async () => {
  if (currentSurface.value !== "publication") {
    publicationAuditEvents.value = [];
    return;
  }
  const runtimeAssetId = effectiveSelectedPublicationGroupKey.value;
  if (!runtimeAssetId) {
    publicationAuditEvents.value = [];
    return;
  }
  try {
    const result = await serverAPI.listPublicationAuditEvents({
      runtimeAssetId,
      limit: 12,
    });
    publicationAuditEvents.value = Array.isArray(result?.data)
      ? (result.data as PublicationAuditEventRecord[])
      : [];
  } catch {
    publicationAuditEvents.value = [];
  }
};

const resetCreateForm = () => {
  formMode.value = "create";
  editingRowId.value = "";
  createForm.value = {
    name: "",
    baseUrl: "",
    method: "GET",
    path: "",
    description: "",
    businessDomain: "",
    riskLevel: "medium",
    publishEnabled: false,
    probeUrl: "",
    governanceOwner: "",
    governanceNotes: "",
  };
  createFormRef.value?.clearValidate();
};

const resetPublicationForm = () => {
  publicationMembershipId.value = "";
  publicationRuntimeType.value = "";
  publicationForm.value = {
    publicationRevision: 0,
    publicationState: "draft",
    intentName: "",
    descriptionForLlm: "",
    operatorNotes: "",
    visibility: "internal",
    profileStatus: "draft",
    routePath: "",
    routeMethod: "GET",
    upstreamPath: "",
    upstreamMethod: "GET",
    routeVisibility: "internal",
    authPolicyRef: "",
    trafficPolicyRef: "",
    timeoutMs: undefined,
  };
};

const resetPublicationTargetForm = () => {
  publicationTargetForm.value = {
    type: selectedPublicationTargetType.value,
    name: "",
    displayName: "",
    description: "",
    policyBindingRef: "",
  };
};

const mapPublicationCandidateRow = (
  item: PublicationCandidateRecord,
): PublicationCandidateRow => {
  const endpoint = item.endpointDefinition;
  const sourceServiceAsset = item.sourceServiceAsset;
  const metadata = (endpoint.metadata || {}) as Record<string, any>;
  const baseUrl = deriveBaseUrlFromAsset(sourceServiceAsset || undefined);
  const location = parseGroupLocation(baseUrl);
  const displayName = String(
    metadata.displayName ||
      sourceServiceAsset?.displayName ||
      endpoint.summary ||
      endpoint.operationId ||
      endpoint.path,
  ).trim();

  return {
    endpointDefinitionId: endpoint.id,
    sourceServiceAssetId: endpoint.sourceServiceAssetId,
    groupKey: endpoint.sourceServiceAssetId,
    groupName: sourceServiceAsset?.displayName || displayName || location.hostPort,
    hostPort: location.hostPort,
    basePath: location.basePath,
    name: displayName || endpoint.path,
    methodPath: `${endpoint.method} ${endpoint.path}`,
    readinessState: item.readiness.ready ? "ready" : "blocked",
    readinessSummary: item.readiness.ready
      ? t("endpointRegistry.messages.publicationReadinessPassed")
      : item.readiness.reasons.join("; ") || t("endpointRegistry.messages.publicationReadinessPending"),
    lifecycleStatus: endpoint.status || "draft",
    lastProbeStatus: String(metadata.lastProbeStatus || "unknown"),
    updatedAtText: endpoint.updatedAt ? new Date(endpoint.updatedAt).toLocaleString() : "-",
    runtimeTargetsSummary:
      item.runtimeMemberships.length > 0
        ? item.runtimeMemberships
            .map(target => `${target.runtimeAssetName} (${target.runtimeAssetType === "gateway_service" ? filterLabel.value.gateway : filterLabel.value.mcp})`)
            .join("; ")
        : t("endpointRegistry.publicationBuilder.noTarget"),
  };
};

const resetTestDialog = () => {
  testDialogLoading.value = false;
  testExecuting.value = false;
  testDialogError.value = "";
  testDialogEndpointId.value = "";
  testDialogEndpoint.value = null;
  testDialogTestingState.value = null;
  testDialogParametersText.value = "{}";
  testDialogResult.value = "";
};

const openPublicationTargetDialog = () => {
  resetPublicationTargetForm();
  showPublicationTargetDialog.value = true;
};

const submitPublicationTargetForm = async () => {
  try {
    publicationTargetSaving.value = true;
    const result = await serverAPI.createPublicationRuntimeAsset({
      type: publicationTargetForm.value.type,
      name: publicationTargetForm.value.name.trim(),
      displayName: publicationTargetForm.value.displayName.trim() || undefined,
      description: publicationTargetForm.value.description.trim() || undefined,
      policyBindingRef: publicationTargetForm.value.policyBindingRef.trim() || undefined,
    });
    const createdId = result?.runtimeAsset?.id;
    showPublicationTargetDialog.value = false;
    await loadOverview();
    if (createdId) {
      selectedPublicationTargetType.value = publicationTargetForm.value.type;
      selectedPublicationTargetRuntimeAssetId.value = createdId;
    }
    ElMessage.success(t("endpointRegistry.publicationBuilder.targetCreateSuccess"));
  } catch (error: any) {
    ElMessage.error(
      error?.message || t("endpointRegistry.publicationBuilder.targetCreateFailed"),
    );
  } finally {
    publicationTargetSaving.value = false;
  }
};

const addSelectedPublicationCandidatesToTarget = async () => {
  if (!selectedPublicationTargetRuntimeAssetId.value) {
    ElMessage.warning(t("endpointRegistry.publicationBuilder.selectTargetFirst"));
    return;
  }
  if (selectedPublicationCandidateIds.value.length === 0) {
    ElMessage.warning(t("endpointRegistry.publicationBuilder.selectCandidatesFirst"));
    return;
  }

  try {
    publicationTargetSaving.value = true;
    await serverAPI.addPublicationRuntimeMemberships(
      selectedPublicationTargetRuntimeAssetId.value,
      {
        endpointDefinitionIds: selectedPublicationCandidateIds.value,
      },
    );
    selectedPublicationCandidateIds.value = [];
    await loadOverview();
    ElMessage.success(t("endpointRegistry.publicationBuilder.addCandidatesSuccess"));
  } catch (error: any) {
    ElMessage.error(
      error?.message || t("endpointRegistry.publicationBuilder.addCandidatesFailed"),
    );
  } finally {
    publicationTargetSaving.value = false;
  }
};

const executeRuntimeAssetAction = async (
  runtimeAssetId: string,
  action: "deploy" | "start" | "stop" | "redeploy",
  runtimeAssetType?: string,
) => {
  const runtimeAsset = runtimeAssetMap.value.get(runtimeAssetId) || null;
  const runtimeAssetName =
    runtimeAsset?.asset.displayName || runtimeAsset?.asset.name || runtimeAssetId;
  const actionLabel = t(`endpointRegistry.runtimeActions.${action}`);

  try {
    setActionLoading(runtimeAssetId, action);
    if (action === "deploy") {
      if (runtimeAssetType === "gateway_service") {
        await runtimeAssetsAPI.deployGatewayRuntimeAsset(runtimeAssetId);
      } else {
        await runtimeAssetsAPI.deployMcpRuntimeAsset(runtimeAssetId);
      }
    } else if (action === "start") {
      await runtimeAssetsAPI.startRuntimeAsset(runtimeAssetId);
    } else if (action === "stop") {
      await runtimeAssetsAPI.stopRuntimeAsset(runtimeAssetId);
    } else {
      await runtimeAssetsAPI.redeployRuntimeAsset(runtimeAssetId);
    }
    await loadOverview();
    pushOperationFeedEntry({
      level: "success",
      title: `${actionLabel} ${runtimeAssetName}`,
      summary: t(`endpointRegistry.runtimeActions.${action}Success`),
      details: `runtimeAssetId=${runtimeAssetId}; type=${runtimeAssetType || runtimeAsset?.asset.type || "-"}`,
    });
    ElMessage.success(
      t(`endpointRegistry.runtimeActions.${action}Success`),
    );
  } catch (error: any) {
    pushOperationFeedEntry({
      level: "error",
      title: `${actionLabel} ${runtimeAssetName}`,
      summary: t(`endpointRegistry.runtimeActions.${action}Failed`),
      details: error?.message || t(`endpointRegistry.runtimeActions.${action}Failed`),
    });
    ElMessage.error(
      error?.message || t(`endpointRegistry.runtimeActions.${action}Failed`),
    );
  } finally {
    setActionLoading(runtimeAssetId, "");
  }
};

const formatTestDialogTimestamp = (value?: unknown) => {
  if (!value) return "-";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
};

const handlePublicationCandidateSelectionChange = (rows: PublicationCandidateRow[]) => {
  selectedPublicationCandidateIds.value = rows.map(item => item.endpointDefinitionId);
};

const handlePublicationMembershipSelectionChange = (rows: EndpointRow[]) => {
  selectedPublicationMembershipIds.value = rows.map(item => item.id);
};

const clearPublicationMembershipSelection = () => {
  selectedPublicationMembershipIds.value = [];
  publicationMembershipTableRef.value?.clearSelection();
};

const selectPublicationMembershipRows = (mode: "publishable" | "active") => {
  const targetRows = (selectedPublicationGroup.value?.endpoints || []).filter(row =>
    mode === "publishable"
      ? row.readinessState === "ready" && row.publicationState !== "active"
      : row.publicationState === "active",
  );
  selectedPublicationMembershipIds.value = targetRows.map(row => row.id);
  publicationMembershipTableRef.value?.clearSelection();
  for (const row of targetRows) {
    publicationMembershipTableRef.value?.toggleRowSelection(row, true);
  }
};

const formatActivityTimestamp = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
};

const getActivityLevelTagType = (level: "success" | "warning" | "error" | "info") =>
  level === "error" ? "danger" : level;

const getLastBatchRunAlertType = (run: BatchPublicationRun) => {
  if (run.failedCount === 0) {
    return "success";
  }
  if (run.successCount > 0) {
    return "warning";
  }
  return "error";
};

const getLastBatchRunTitle = (run: BatchPublicationRun) =>
  t(`endpointRegistry.batchActions.${run.action}ResultTitle`);

const getLastBatchRunSummary = (run: BatchPublicationRun) =>
  t("endpointRegistry.batchActions.resultSummary", {
    success: run.successCount,
    failed: run.failedCount,
  });

const getLastBatchRunNextStep = (run: BatchPublicationRun) => {
  const runtimeAsset =
    (run.runtimeAssetId && runtimeAssetMap.value.get(run.runtimeAssetId)) || null;

  if (run.action === "offline") {
    return t("endpointRegistry.batchActions.nextReview");
  }
  if (run.successCount === 0) {
    return t("endpointRegistry.batchActions.nextFixFailures");
  }
  if (!runtimeAsset) {
    return t("endpointRegistry.batchActions.nextReview");
  }
  if (!hasRuntimeDeployment(runtimeAsset)) {
    return t("endpointRegistry.batchActions.nextDeployRuntime");
  }
  if (!["running", "active"].includes(getRuntimeAssetStatus(runtimeAsset))) {
    return t("endpointRegistry.batchActions.nextStartRuntime");
  }
  return t("endpointRegistry.batchActions.nextObserveRuntime");
};

const handleBatchPublicationAction = async (action: "publish" | "offline") => {
  const selectedRows = selectedPublicationMembershipRows.value;
  const actionableRows = selectedRows.filter(row =>
    action === "publish"
      ? row.readinessState === "ready" && row.publicationState !== "active"
      : row.publicationState === "active",
  );

  if (actionableRows.length === 0) {
    ElMessage.warning(
      t(
        action === "publish"
          ? "endpointRegistry.batchActions.publishUnavailable"
          : "endpointRegistry.batchActions.offlineUnavailable",
      ),
    );
    return;
  }

  try {
    await ElMessageBox.confirm(
      t(
        action === "publish"
          ? "endpointRegistry.batchActions.confirmPublishText"
          : "endpointRegistry.batchActions.confirmOfflineText",
        { count: actionableRows.length },
      ),
      t(
        action === "publish"
          ? "endpointRegistry.batchActions.confirmPublishTitle"
          : "endpointRegistry.batchActions.confirmOfflineTitle",
      ),
      { type: "warning" },
    );

    batchPublicationActionLoading.value = action;
    const result =
      action === "publish"
        ? await serverAPI.batchPublishRuntimeMemberships({
            membershipIds: actionableRows.map(row => requirePublicationMembershipRow(row)),
            publishToHttp:
              selectedPublicationRuntimeAsset.value?.asset.type === "gateway_service"
                ? true
                : undefined,
            publishToMcp:
              selectedPublicationRuntimeAsset.value?.asset.type === "gateway_service"
                ? undefined
                : true,
          })
        : await serverAPI.batchOfflineRuntimeMemberships({
            membershipIds: actionableRows.map(row => requirePublicationMembershipRow(row)),
            offlineHttp:
              selectedPublicationRuntimeAsset.value?.asset.type === "gateway_service"
                ? true
                : undefined,
            offlineMcp:
              selectedPublicationRuntimeAsset.value?.asset.type === "gateway_service"
                ? undefined
                : true,
          });

    const batchRun = result?.batchRun || {};
    const items = Array.isArray(result?.items) ? result.items : [];
    const successCount = Number(batchRun.successCount ?? items.filter((item: any) => item.status === "success").length);
    const failedCount = Number(batchRun.failedCount ?? items.filter((item: any) => item.status === "failed").length);
    const failures = items
      .filter((item: any) => item.status === "failed")
      .map((item: any) => `${item.membershipId}: ${item.message || "-"}`);

    lastPublicationBatchRun.value = {
      id: batchRun.id,
      action,
      successCount,
      failedCount,
      runtimeAssetId: batchRun.runtimeAssetId || selectedPublicationRuntimeAsset.value?.asset.id,
      runtimeAssetType: batchRun.runtimeAssetType || selectedPublicationRuntimeAsset.value?.asset.type,
      status: batchRun.status,
      at: batchRun.finishedAt || batchRun.createdAt || new Date().toISOString(),
    };
    pushOperationFeedEntry({
      level: failedCount === 0 ? "success" : successCount > 0 ? "warning" : "error",
      title: t(
        action === "publish"
          ? "endpointRegistry.batchActions.publish"
          : "endpointRegistry.batchActions.offline",
      ),
      summary: t(
        "endpointRegistry.batchActions.resultSummary",
        {
          success: successCount,
          failed: failedCount,
        },
      ),
      details: failures.length > 0 ? failures.join("; ") : undefined,
    });

    await loadOverview();
    clearPublicationMembershipSelection();
    ElMessage.success(
      t("endpointRegistry.batchActions.completed", {
        success: successCount,
        failed: failedCount,
      }),
    );
  } catch (error: any) {
    if (error === "cancel" || error === "close") {
      return;
    }
    ElMessage.error(
      error?.message ||
        t(
          action === "publish"
            ? "endpointRegistry.batchActions.publishFailed"
            : "endpointRegistry.batchActions.offlineFailed",
        ),
    );
  } finally {
    batchPublicationActionLoading.value = "";
  }
};

const formatInlineTestResult = (result: Record<string, any>) =>
  JSON.stringify(
    {
      passed: Boolean(result?.test?.passed),
      httpStatus: result?.test?.httpStatus ?? null,
      durationMs: result?.test?.durationMs ?? null,
      method: result?.test?.method ?? null,
      url: result?.test?.url ?? null,
      errorMessage: result?.test?.errorMessage ?? null,
      testingState: result?.testingState ?? null,
    },
    null,
    2,
  );

const openTestDialog = async (endpointId: string, row?: EndpointRow) => {
  testDialogLoading.value = true;
  testDialogError.value = "";
  testDialogEndpointId.value = endpointId;
  testDialogParametersText.value = "{}";
  testDialogResult.value = "";
  showTestDialog.value = true;

  try {
    const [detail, testingState] = await Promise.all([
      serverAPI.getEndpointAssetDetails(endpointId),
      serverAPI.getEndpointAssetTestingState(endpointId),
    ]);

    const endpoint = detail?.endpoint || {};
    const sourceServiceAsset = (detail?.sourceServiceAsset || {}) as SourceServiceAssetRecord;
    const metadata = (endpoint.metadata || {}) as Record<string, any>;
    const fallbackBaseUrl = deriveBaseUrlFromAsset(sourceServiceAsset);

    testDialogEndpoint.value = {
      id: endpointId,
      endpointDefinitionId: endpointId,
      sourceServiceAssetId: endpoint.sourceServiceAssetId,
      name: String(
        metadata.displayName ||
          sourceServiceAsset.displayName ||
          endpoint.summary ||
          row?.name ||
          endpoint.path ||
          endpointId,
      ),
      baseUrl: row?.baseUrl || fallbackBaseUrl,
      groupName:
        row?.groupName ||
        sourceServiceAsset.displayName ||
        metadata.displayName ||
        fallbackBaseUrl,
      endpointPath: endpoint.path || row?.endpointPath || "/",
      methodPath: `${endpoint.method || "GET"} ${endpoint.path || row?.endpointPath || "/"}`,
      sourceType: row?.sourceType || "manual",
      lifecycleStatus: endpoint.status || row?.lifecycleStatus || "draft",
      publishEnabled: Boolean(endpoint.publishEnabled ?? row?.publishEnabled),
      lastProbeStatus: String(metadata.lastProbeStatus || row?.lastProbeStatus || "unknown"),
      lastProbeSummary: row?.lastProbeSummary || "",
      updatedAtText: row?.updatedAtText || "-",
      testStatus: String(testingState?.testStatus || metadata.testStatus || row?.testStatus || "untested"),
      qualificationState: String(
        testingState?.qualificationState ||
          metadata.qualificationState ||
          row?.qualificationState ||
          "registered",
      ),
    };
    testDialogTestingState.value = testingState || null;
  } catch (error: any) {
    testDialogError.value = error?.message || t("endpointRegistry.testDialog.loadFailed");
  } finally {
    testDialogLoading.value = false;
  }
};

const buildManualRegistrationPayload = () => {
  const normalizedBaseUrl = createForm.value.baseUrl.trim().replace(/\/+$/, "");
  return {
    name: createForm.value.name.trim(),
    baseUrl: normalizedBaseUrl,
    method: createForm.value.method.toUpperCase(),
    path: createForm.value.path.trim(),
    description: createForm.value.description?.trim() || undefined,
    businessDomain: createForm.value.businessDomain?.trim() || undefined,
    riskLevel: createForm.value.riskLevel || undefined,
  };
};

const persistCreateForm = async () => {
  const payload = buildManualRegistrationPayload();

  if (currentSurface.value === "registration" && formMode.value === "edit-manual" && editingRowId.value) {
    const result = await serverAPI.updateManualEndpointAsset(editingRowId.value, payload);
    ElMessage.success(t("endpointRegistry.messages.updateSuccess"));
    return result;
  }

  if (currentSurface.value === "governance" && formMode.value === "edit-imported" && editingRowId.value) {
    const result = await serverAPI.updateEndpointGovernance(editingRowId.value, {
      publishEnabled: createForm.value.publishEnabled,
      summary: payload.name,
      description: payload.description,
      metadata: {
        businessDomain: payload.businessDomain,
        riskLevel: payload.riskLevel,
        probeUrl: createForm.value.probeUrl?.trim() || undefined,
        displayName: payload.name,
        governanceOwner: createForm.value.governanceOwner?.trim() || undefined,
        governanceNotes: createForm.value.governanceNotes?.trim() || undefined,
      },
    });
    ElMessage.success(t("endpointRegistry.messages.importedUpdateSuccess"));
    return result;
  }

  if (currentSurface.value === "registration") {
    const result = await serverAPI.registerManualEndpointAsset(payload);
    ElMessage.success(t("endpointRegistry.messages.createSuccess"));
    return result;
  }

  throw new Error(t("endpointRegistry.messages.manualEndpointCreateUnavailable"));
};

const submitCreateForm = async () => {
  if (!createFormRef.value) return;
  try {
    await createFormRef.value.validate();
    creating.value = true;
    await persistCreateForm();
    showCreateDialog.value = false;
    await loadOverview();
  } catch (error: any) {
    const messageKey = formMode.value === "edit-imported"
      ? "endpointRegistry.messages.importedUpdateFailed"
      : formMode.value === "edit-manual"
        ? "endpointRegistry.messages.updateFailed"
        : "endpointRegistry.messages.createFailed";
    ElMessage.error(error?.message || t(messageKey));
  } finally {
    creating.value = false;
  }
};

const submitCreateFormAndGoTesting = async () => {
  if (!createFormRef.value) return;
  try {
    await createFormRef.value.validate();
    testingFromDialog.value = true;
    const result = await persistCreateForm();
    const endpointId =
      typeof result?.id === "string" && result.id
        ? result.id
        : editingRowId.value;
    showCreateDialog.value = false;
    await loadOverview();
    if (!endpointId) {
      throw new Error(t("endpointRegistry.messages.testNavigationUnavailable"));
    }
    const savedRow = rows.value.find((item) => item.id === endpointId);
    await openTestDialog(endpointId, savedRow);
  } catch (error: any) {
    const messageKey = formMode.value === "edit-manual"
      ? "endpointRegistry.messages.updateFailed"
      : "endpointRegistry.messages.createFailed";
    ElMessage.error(error?.message || t(messageKey));
  } finally {
    testingFromDialog.value = false;
  }
};

const openGovernanceEditDialog = async (row: EndpointRow) => {
  const detail = await serverAPI.getEndpointAssetDetails(row.id);
  const endpoint = detail?.endpoint || {};
  const sourceServiceAsset = detail?.sourceServiceAsset || {};
  const metadata = (endpoint.metadata || {}) as Record<string, any>;
  const baseUrl = deriveBaseUrlFromAsset(sourceServiceAsset as SourceServiceAssetRecord);

  createForm.value = {
    name: String(
      metadata.displayName ||
        sourceServiceAsset.displayName ||
        endpoint.summary ||
        row.name,
    ),
    baseUrl: String(baseUrl || "").replace(/\/+$/, ""),
    method: endpoint.method || "GET",
    path: endpoint.path || "/",
    description: endpoint.description || "",
    businessDomain: metadata.businessDomain || "",
    riskLevel: metadata.riskLevel || "medium",
    publishEnabled: Boolean(endpoint.publishEnabled),
    probeUrl: metadata.probeUrl || buildProbeUrl(baseUrl, endpoint.path || "/"),
    governanceOwner: metadata.governanceOwner || "",
    governanceNotes: metadata.governanceNotes || "",
  };
  editingRowId.value = row.id;
  formMode.value = "edit-imported";
  showCreateDialog.value = true;
};

const openPublicationEditDialog = async (row: EndpointRow) => {
  const membershipId = requirePublicationMembershipRow(row);
  const detail = await serverAPI.getPublicationRuntimeMembershipState(membershipId);
  const profile = (detail?.profile || {}) as Record<string, any>;
  const routeBinding = (detail?.routeBinding || {}) as Record<string, any>;

  publicationMembershipId.value = membershipId;
  publicationRuntimeType.value = row.runtimeAssetType || detail?.runtimeAsset?.type || "";
  publicationForm.value = {
    publicationRevision: Number(detail?.membership?.publicationRevision || 0),
    publicationState: String(detail?.publishBinding?.publishStatus || detail?.membership?.status || "draft"),
    intentName: profile.intentName || row.name,
    descriptionForLlm: profile.descriptionForLlm || "",
    operatorNotes: profile.operatorNotes || "",
    visibility: profile.visibility || "internal",
    profileStatus: profile.status || "draft",
    routePath: routeBinding.routePath || row.endpointPath || "",
    routeMethod: routeBinding.routeMethod || "GET",
    upstreamPath: routeBinding.upstreamPath || row.endpointPath || "",
    upstreamMethod: routeBinding.upstreamMethod || "GET",
    routeVisibility: routeBinding.routeVisibility || "internal",
    authPolicyRef: routeBinding.authPolicyRef || "",
    trafficPolicyRef: routeBinding.trafficPolicyRef || "",
    timeoutMs:
      typeof routeBinding.timeoutMs === "number" ? routeBinding.timeoutMs : undefined,
  };
  showPublicationDialog.value = true;
};

const submitPublicationForm = async () => {
  if (!publicationMembershipId.value) return;
  try {
    publicationSaving.value = true;
    await serverAPI.updatePublicationRuntimeMembershipProfile(
      publicationMembershipId.value,
      {
        intentName: publicationForm.value.intentName.trim() || undefined,
        descriptionForLlm: publicationForm.value.descriptionForLlm.trim() || undefined,
        operatorNotes: publicationForm.value.operatorNotes.trim() || undefined,
        visibility: publicationForm.value.visibility || undefined,
        status: publicationForm.value.profileStatus || undefined,
      },
    );

    if (publicationRuntimeType.value === "gateway_service") {
      await serverAPI.configurePublicationRuntimeMembershipGatewayRoute(
        publicationMembershipId.value,
        {
          routePath: publicationForm.value.routePath.trim() || undefined,
          upstreamPath: publicationForm.value.upstreamPath.trim() || undefined,
          routeMethod: publicationForm.value.routeMethod || undefined,
          upstreamMethod: publicationForm.value.upstreamMethod || undefined,
          routeVisibility: publicationForm.value.routeVisibility || undefined,
          authPolicyRef: publicationForm.value.authPolicyRef.trim() || undefined,
          trafficPolicyRef: publicationForm.value.trafficPolicyRef.trim() || undefined,
          timeoutMs: publicationForm.value.timeoutMs,
        },
      );
    }

    ElMessage.success(t("endpointRegistry.messages.publicationConfigUpdated"));
    showPublicationDialog.value = false;
    await loadOverview();
  } catch (error: any) {
    ElMessage.error(error?.message || t("endpointRegistry.messages.publicationConfigUpdateFailed"));
  } finally {
    publicationSaving.value = false;
  }
};

const handleEdit = async (row: EndpointRow) => {
  try {
    setActionLoading(row.id, "edit");
    if (currentSurface.value === "publication") {
      await openPublicationEditDialog(row);
      return;
    }
    if (currentSurface.value === "governance") {
      await openGovernanceEditDialog(row);
      return;
    }
    if (currentSurface.value === "registration" && row.sourceType === "manual") {
      const detail = await serverAPI.getEndpointAssetDetails(row.id);
      const endpoint = detail?.endpoint || {};
      const sourceServiceAsset = detail?.sourceServiceAsset || {};
      const metadata = (endpoint.metadata || {}) as Record<string, any>;
      const baseUrl = deriveBaseUrlFromAsset(sourceServiceAsset as SourceServiceAssetRecord);

      createForm.value = {
        name: String(
          metadata.displayName ||
            sourceServiceAsset.displayName ||
            endpoint.summary ||
            row.name,
        ),
        baseUrl: String(baseUrl || "").replace(/\/+$/, ""),
        method: endpoint.method || "GET",
        path: endpoint.path || "/",
        description: endpoint.description || "",
        businessDomain: metadata.businessDomain || "",
        riskLevel: metadata.riskLevel || "medium",
        publishEnabled: Boolean(endpoint.publishEnabled),
        probeUrl: metadata.probeUrl || buildProbeUrl(baseUrl, endpoint.path || "/"),
        governanceOwner: metadata.governanceOwner || "",
        governanceNotes: metadata.governanceNotes || "",
      };
      editingRowId.value = row.id;
      formMode.value = "edit-manual";
      showCreateDialog.value = true;
      return;
    }
  } catch (error: any) {
    ElMessage.error(error?.message || t("endpointRegistry.messages.updateFailed"));
  } finally {
    setActionLoading(row.id, "");
  }
};

const handleDelete = async (row: EndpointRow) => {
  try {
    await ElMessageBox.confirm(
      t("endpointRegistry.messages.confirmDeleteText", { name: row.name }),
      t("endpointRegistry.messages.confirmDeleteTitle"),
      { type: "warning" },
    );
    setActionLoading(row.id, "delete");
    if (currentSurface.value === "registration") {
      await serverAPI.deleteManualEndpointAsset(row.id);
    } else {
      await serverAPI.deleteServer(row.id);
    }
    ElMessage.success(t("endpointRegistry.messages.deleteSuccess"));
    await loadOverview();
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error?.message || t("endpointRegistry.messages.deleteFailed"));
  } finally {
    setActionLoading(row.id, "");
  }
};

const handleProbe = async (row: EndpointRow) => {
  try {
    setActionLoading(row.id, "probe");
    const result = await serverAPI.probeEndpointAsset(row.id);
    const probeStatus = result?.probe?.status || "unknown";
    const feedback = withGovernanceScopeHint(
      formatProbeFeedback(result),
      row,
      probeStatus,
    );
    pushOperationFeedEntry({
      level:
        probeStatus === "healthy"
          ? "success"
          : probeStatus === "unknown"
            ? "info"
            : "error",
      title: `${t("endpointRegistry.actions.probe")} · ${row.methodPath}`,
      summary: t("endpointRegistry.messages.probeFinished", {
        status: getProbeLabel(probeStatus),
      }),
      details: feedback,
    });
    if (probeStatus === "healthy") {
      ElMessage.success(
        t("endpointRegistry.messages.probeFinished", {
          status: getProbeLabel(probeStatus),
        }),
      );
    } else if (probeStatus === "unknown") {
      ElMessage.warning(
        t("endpointRegistry.messages.probeFinished", {
          status: getProbeLabel(probeStatus),
        }),
      );
    } else {
      ElMessage.error(
        t("endpointRegistry.messages.probeFinished", {
          status: getProbeLabel(probeStatus),
        }),
      );
    }
    await loadOverview();
  } catch (error: any) {
    pushOperationFeedEntry({
      level: "error",
      title: `${t("endpointRegistry.actions.probe")} · ${row.methodPath}`,
      summary: t("endpointRegistry.messages.probeFailed"),
      details: error?.message || t("endpointRegistry.messages.probeFailed"),
    });
    ElMessage.error(error?.message || t("endpointRegistry.messages.probeFailed"));
  } finally {
    setActionLoading(row.id, "");
  }
};

const handleTesting = async (row: EndpointRow) => {
  await openTestDialog(row.id, row);
};

const executeInlineEndpointTest = async () => {
  if (!testDialogEndpointId.value) return;
  try {
    testExecuting.value = true;
    testDialogError.value = "";
    let parameters: Record<string, unknown> = {};
    const input = testDialogParametersText.value.trim();
    if (input) {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parameters = parsed as Record<string, unknown>;
      } else {
        throw new Error(t("endpointRegistry.testDialog.parametersObjectRequired"));
      }
    }

    const result = await serverAPI.executeEndpointAssetTest(testDialogEndpointId.value, {
      parameters,
    });
    testDialogTestingState.value = result?.testingState || null;
    if (testDialogEndpoint.value) {
      testDialogEndpoint.value = {
        ...testDialogEndpoint.value,
        testStatus: String(result?.testingState?.testStatus || testDialogEndpoint.value.testStatus || "untested"),
        qualificationState: String(
          result?.testingState?.qualificationState ||
            testDialogEndpoint.value.qualificationState ||
            "registered",
        ),
      };
    }
    testDialogResult.value = formatInlineTestResult(result || {});
    await loadOverview();
  } catch (error: any) {
    testDialogError.value = error?.message || t("endpointRegistry.testDialog.executeFailed");
  } finally {
    testExecuting.value = false;
  }
};

const handleViewRuntime = async (row: EndpointRow) => {
  await router.push({
    path: "/runtime-assets",
    query: {
      q: row.runtimeAssetName || row.runtimeAssetId || row.name,
    },
  });
};

const handleReadiness = async (row: EndpointRow) => {
  try {
    setActionLoading(row.id, "readiness");
    const result =
      currentSurface.value === "publication"
        ? await serverAPI.getPublicationRuntimeMembershipState(
            requirePublicationMembershipRow(row),
          )
        : await serverAPI.getEndpointAssetReadiness(row.id);
    const ready =
      currentSurface.value === "publication"
        ? Boolean(result?.readiness?.ready)
        : Boolean(result?.ready);
    const reasons =
      currentSurface.value === "publication"
        ? Array.isArray(result?.readiness?.reasons)
          ? result.readiness.reasons
          : []
        : Array.isArray(result?.reasons)
          ? result.reasons
          : [];
    if (ready) {
      pushOperationFeedEntry({
        level: "success",
        title: `${t("endpointRegistry.actions.readiness")} · ${row.methodPath}`,
        summary: t(
          row.sourceType === "imported"
            ? "endpointRegistry.messages.readinessReadyImported"
            : "endpointRegistry.messages.readinessReady",
        ),
      });
      ElMessage.success(
        t(
          row.sourceType === "imported"
            ? "endpointRegistry.messages.readinessReadyImported"
            : "endpointRegistry.messages.readinessReady",
        ),
      );
      return;
    }
    pushOperationFeedEntry({
      level: "warning",
      title: `${t("endpointRegistry.actions.readiness")} · ${row.methodPath}`,
      summary: t("endpointRegistry.messages.readinessBlockedBrief"),
      details: reasons.join("; ") || t("endpointRegistry.messages.unknownReason"),
    });
    ElMessage.warning(
      t("endpointRegistry.messages.readinessBlockedBrief"),
    );
  } catch (error: any) {
    pushOperationFeedEntry({
      level: "error",
      title: `${t("endpointRegistry.actions.readiness")} · ${row.methodPath}`,
      summary: t("endpointRegistry.messages.readinessFailed"),
      details: error?.message || t("endpointRegistry.messages.readinessFailed"),
    });
    ElMessage.error(
      error?.message || t("endpointRegistry.messages.readinessFailed"),
    );
  } finally {
    setActionLoading(row.id, "");
  }
};

const handlePublish = async (row: EndpointRow) => {
  const publicationActionLabel =
    currentSurface.value === "publication"
      ? getPublicationActionLabel(row)
      : t("endpointRegistry.actions.publish");
  try {
    await ElMessageBox.confirm(
      currentSurface.value === "publication"
        ? t("endpointRegistry.messages.confirmPublishToRuntime", {
            action: publicationActionLabel,
            methodPath: row.methodPath,
            target: row.runtimeAssetName || row.baseUrl,
          })
        : t(
            row.sourceType === "imported"
              ? "endpointRegistry.messages.confirmPublishImportedText"
              : "endpointRegistry.messages.confirmPublishText",
            { name: row.name, methodPath: row.methodPath },
          ),
      currentSurface.value === "publication"
        ? publicationActionLabel
        : t("endpointRegistry.messages.confirmPublishTitle"),
      { type: "warning" },
    );
    setActionLoading(row.id, "publish");
    if (currentSurface.value === "publication") {
      const membershipId = requirePublicationMembershipRow(row);
      await serverAPI.publishRuntimeMembership(membershipId, {
        publishToHttp: row.runtimeAssetType === "gateway_service" ? true : undefined,
        publishToMcp: row.runtimeAssetType === "gateway_service" ? undefined : true,
      });
    } else {
      throw new Error(t("endpointRegistry.messages.publishActionUnavailable"));
    }
    const publishSuccessSummary =
      currentSurface.value === "publication"
        ? t("endpointRegistry.messages.publishCompletedForRuntime", {
            action: publicationActionLabel,
            target: row.runtimeAssetName || row.baseUrl,
          })
        : t(
            row.sourceType === "imported"
              ? "endpointRegistry.messages.publishSuccessImported"
              : "endpointRegistry.messages.publishSuccess",
          );
    const publishSuccessToast =
      currentSurface.value === "publication"
        ? t("endpointRegistry.messages.publishCompleted", { action: publicationActionLabel })
        : t(
            row.sourceType === "imported"
              ? "endpointRegistry.messages.publishSuccessImported"
              : "endpointRegistry.messages.publishSuccess",
          );
    pushOperationFeedEntry({
      level: "success",
      title:
        currentSurface.value === "publication"
          ? `${publicationActionLabel} · ${row.methodPath}`
          : `${t("endpointRegistry.actions.publish")} · ${row.methodPath}`,
      summary: publishSuccessSummary,
      details:
        currentSurface.value === "publication"
          ? `runtimeAssetId=${row.runtimeAssetId || "-"}; membershipId=${row.runtimeMembershipId || "-"}; target=${row.runtimeAssetName || row.baseUrl}; revision=${row.publicationRevision || 0}`
          : row.sourceType === "imported"
            ? t("endpointRegistry.messages.importedScopeSuffix")
            : undefined,
    });
    ElMessage.success(publishSuccessToast);
    await loadOverview();
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    pushOperationFeedEntry({
      level: "error",
      title:
        currentSurface.value === "publication"
          ? `${publicationActionLabel} · ${row.methodPath}`
          : `${t("endpointRegistry.actions.publish")} · ${row.methodPath}`,
      summary:
        currentSurface.value === "publication"
          ? t("endpointRegistry.messages.publishFailedWithAction", { action: publicationActionLabel })
          : t("endpointRegistry.messages.publishFailed"),
      details:
        currentSurface.value === "publication"
          ? `runtimeAssetId=${row.runtimeAssetId || "-"}; membershipId=${row.runtimeMembershipId || "-"}; ${getPublicationFailureHint(error)}`
          : error?.message || t("endpointRegistry.messages.publishFailed"),
    });
    ElMessage.error(
      currentSurface.value === "publication"
        ? getPublicationFailureHint(error)
        : error?.message || t("endpointRegistry.messages.publishFailed"),
    );
  } finally {
    setActionLoading(row.id, "");
  }
};

const handleOffline = async (row: EndpointRow) => {
  const offlineActionLabel =
    currentSurface.value === "publication"
      ? getOfflineActionLabel(row)
      : t("endpointRegistry.actions.offline");
  try {
    await ElMessageBox.confirm(
      currentSurface.value === "publication"
        ? t("endpointRegistry.messages.confirmOfflineFromRuntime", {
            action: offlineActionLabel,
            methodPath: row.methodPath,
            target: row.runtimeAssetName || row.baseUrl,
          })
        : t(
            row.sourceType === "imported"
              ? "endpointRegistry.messages.confirmOfflineImportedText"
              : "endpointRegistry.messages.confirmOfflineText",
            { name: row.name, methodPath: row.methodPath },
          ),
      currentSurface.value === "publication"
        ? offlineActionLabel
        : t("endpointRegistry.messages.confirmOfflineTitle"),
      { type: "warning" },
    );
    setActionLoading(row.id, "offline");
    if (currentSurface.value === "publication") {
      const membershipId = requirePublicationMembershipRow(row);
      await serverAPI.offlineRuntimeMembership(membershipId, {
        offlineHttp: row.runtimeAssetType === "gateway_service" ? true : undefined,
        offlineMcp: row.runtimeAssetType === "gateway_service" ? undefined : true,
      });
    } else {
      throw new Error(t("endpointRegistry.messages.offlineActionUnavailable"));
    }
    pushOperationFeedEntry({
      level: "success",
      title:
        currentSurface.value === "publication"
          ? `${offlineActionLabel} · ${row.methodPath}`
          : `${t("endpointRegistry.actions.offline")} · ${row.methodPath}`,
      summary:
        currentSurface.value === "publication"
          ? t("endpointRegistry.messages.offlineCompletedForRuntime", {
              action: offlineActionLabel,
              target: row.runtimeAssetName || row.baseUrl,
            })
          : t(
              row.sourceType === "imported"
                ? "endpointRegistry.messages.offlineSuccessImported"
                : "endpointRegistry.messages.offlineSuccess",
            ),
      details:
        currentSurface.value === "publication"
          ? `runtimeAssetId=${row.runtimeAssetId || "-"}; membershipId=${row.runtimeMembershipId || "-"}; target=${row.runtimeAssetName || row.baseUrl}`
          : row.sourceType === "imported"
            ? t("endpointRegistry.messages.importedScopeSuffix")
            : undefined,
    });
    ElMessage.success(
      currentSurface.value === "publication"
        ? t("endpointRegistry.messages.offlineCompleted", { action: offlineActionLabel })
        : t(
            row.sourceType === "imported"
              ? "endpointRegistry.messages.offlineSuccessImported"
              : "endpointRegistry.messages.offlineSuccess",
          ),
    );
    await loadOverview();
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    pushOperationFeedEntry({
      level: "error",
      title:
        currentSurface.value === "publication"
          ? `${offlineActionLabel} · ${row.methodPath}`
          : `${t("endpointRegistry.actions.offline")} · ${row.methodPath}`,
      summary:
        currentSurface.value === "publication"
          ? t("endpointRegistry.messages.offlineFailedWithAction", { action: offlineActionLabel })
          : t("endpointRegistry.messages.offlineFailed"),
      details:
        currentSurface.value === "publication"
          ? `runtimeAssetId=${row.runtimeAssetId || "-"}; membershipId=${row.runtimeMembershipId || "-"}; ${getPublicationFailureHint(error)}`
          : error?.message || t("endpointRegistry.messages.offlineFailed"),
    });
    ElMessage.error(
      currentSurface.value === "publication"
        ? getPublicationFailureHint(error)
        : error?.message || t("endpointRegistry.messages.offlineFailed"),
    );
  } finally {
    setActionLoading(row.id, "");
  }
};

onMounted(async () => {
  if (route.meta?.productSurface === "publication") {
    selectedReadinessState.value = "ready";
  }
  const sourceType = route.query.sourceType;
  const keyword = route.query.q;
  if (
    !isManualRegistrationView.value &&
    (sourceType === "all" ||
      sourceType === "imported" ||
      sourceType === "manual" ||
      sourceType === "mcp" ||
      sourceType === "gateway")
  ) {
    selectedFilter.value = sourceType;
  }
  if (typeof keyword === "string") {
    search.value = keyword;
  }
  if (
    route.meta?.productSurface === "registration" &&
    route.query.action === "create-manual"
  ) {
    openCreateDialog();
  }
  await loadOverview();
});

watch(selectedFilter, async (value) => {
  if (isManualRegistrationView.value) {
    return;
  }
  await router.replace({
    query: {
      ...route.query,
      sourceType: value,
    },
  });
  await loadOverview();
});

watch(selectedTestingState, async () => {
  if (currentSurface.value !== "governance") {
    return;
  }
  await loadOverview();
});

watch(selectedReadinessState, async () => {
  if (currentSurface.value !== "governance" && currentSurface.value !== "publication") {
    return;
  }
  await loadOverview();
});

watch(selectedPublicationTargetType, () => {
  publicationTargetForm.value.type = selectedPublicationTargetType.value;
  const firstTarget = publicationTargetOptions.value[0];
  selectedPublicationTargetRuntimeAssetId.value = firstTarget?.asset?.id || "";
});

watch(effectiveSelectedPublicationCandidateGroupKey, () => {
  selectedPublicationCandidateIds.value = [];
});

watch(effectiveSelectedPublicationGroupKey, async () => {
  selectedPublicationMembershipRowId.value = "";
  selectedPublicationMembershipIds.value = [];
  lastPublicationBatchRun.value = null;
  publicationMembershipTableRef.value?.clearSelection();
  await loadPublicationAuditTrail();
});

watch(search, async (value) => {
  const keyword = value.trim();
  const nextQuery = {
    ...route.query,
  } as Record<string, string>;

  if (!isManualRegistrationView.value) {
    nextQuery.sourceType = selectedFilter.value;
  } else {
    delete nextQuery.sourceType;
  }

  if (keyword) {
    nextQuery.q = keyword;
  } else {
    delete nextQuery.q;
  }

  await router.replace({ query: nextQuery });
});

watch(
  () => route.fullPath,
  async () => {
    const sourceType = route.query.sourceType;
    if (
      !isManualRegistrationView.value &&
      (sourceType === "all" ||
        sourceType === "imported" ||
        sourceType === "manual" ||
        sourceType === "mcp" ||
        sourceType === "gateway")
    ) {
      selectedFilter.value = sourceType;
    }
    if (route.meta?.productSurface === "publication" && selectedReadinessState.value === "all") {
      selectedReadinessState.value = "ready";
    }
    if (
      route.meta?.productSurface === "registration" &&
      route.query.action === "create-manual"
    ) {
      openCreateDialog();
    }
    await loadOverview();
  },
);
</script>

<style scoped>
.endpoint-registry {
  padding: 20px 24px 24px;
  box-sizing: border-box;
  height: calc(100vh - 60px);
  overflow: auto;
  scrollbar-gutter: stable both-edges;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}

.header-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.governance-help-btn {
  border-color: #c6e2ff;
  color: #1d4ed8;
  background: #eff6ff;
}

.governance-guide {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.governance-guide-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

.governance-guide-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.governance-guide-label {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.governance-guide-section p,
.governance-guide-flow {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: #606266;
}

.page-header h1 {
  margin: 0;
  font-size: 24px;
}

.muted {
  margin: 8px 0 0;
  color: #606266;
}

.toolbar-card {
  margin-bottom: 12px;
}

.publication-surface {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.publication-builder-card {
  min-width: 0;
}

.publication-builder-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
  align-items: center;
}

.publication-target-select {
  width: min(360px, 100%);
}

.publication-target-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.publication-workbench-card {
  margin-bottom: 12px;
}

.publication-workbench-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.publication-workbench-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.publication-checklist {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.publication-flow,
.publication-traceability {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.publication-traceability {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.publication-flow-stage {
  border: 1px solid #dbe3f0;
  border-radius: 10px;
  background: #f8fafc;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.publication-flow-stage-hint {
  font-size: 12px;
  color: #606266;
}

.publication-runtime-handoff {
  border: 1px solid #dbeafe;
  border-radius: 12px;
  padding: 12px;
  background: #f8fbff;
}

.publication-batch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: #fcfcfd;
}

.publication-batch-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.publication-batch-result {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.publication-batch-next {
  font-size: 12px;
  color: #606266;
}

.publication-activity-card {
  margin-bottom: 12px;
}

.publication-activity-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.publication-activity-item {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
  padding: 10px 12px;
}

.publication-activity-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.publication-activity-time {
  font-size: 12px;
  color: #909399;
}

.publication-activity-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.publication-activity-summary,
.publication-activity-details {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #606266;
  word-break: break-word;
}

.publication-runtime-handoff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.publication-runtime-handoff-hint {
  margin-bottom: 12px;
  font-size: 12px;
  line-height: 1.6;
  color: #606266;
}

.publication-runtime-handoff-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}

.publication-dialog-checklist {
  margin-bottom: 12px;
}

.publication-checklist-item {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 10px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.publication-workbench-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.publication-workbench-item {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px;
  background: #fafafa;
}

.publication-workbench-label {
  font-size: 12px;
  color: #909399;
  margin-bottom: 6px;
}

.publication-workbench-value {
  color: #303133;
  line-height: 1.5;
  word-break: break-word;
}

.publication-workbench-actions {
  justify-content: flex-start;
}

.publication-blocker-list {
  margin: 8px 0 0;
  padding-left: 18px;
}

.publication-blocker-group + .publication-blocker-group {
  margin-top: 10px;
}

.publication-blocker-group-title {
  font-size: 12px;
  font-weight: 600;
  color: #303133;
}

.publication-builder-layout {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 12px;
}

.publication-builder-groups,
.publication-builder-detail {
  min-width: 0;
}

.manual-registration-layout {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.manual-groups-card,
.manual-group-detail-card {
  min-width: 0;
}

.manual-groups-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
}

.manual-groups-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.manual-group-item {
  width: 100%;
  border: 1px solid #dcdfe6;
  border-radius: 10px;
  background: #fff;
  padding: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background-color 0.2s ease;
}

.manual-group-item:hover {
  border-color: #409eff;
}

.manual-group-item.is-active {
  border-color: #409eff;
  background: #ecf5ff;
  box-shadow: 0 0 0 1px rgba(64, 158, 255, 0.12);
}

.manual-group-name {
  font-weight: 600;
  color: #303133;
}

.manual-group-url {
  margin-top: 4px;
  color: #606266;
  word-break: break-all;
}

.manual-group-meta {
  margin-top: 8px;
  font-size: 12px;
  color: #909399;
}

.manual-group-base-path {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
  font-family: var(--el-font-family-monospace, Consolas, "Courier New", monospace);
  word-break: break-all;
}

.manual-group-stats {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: #606266;
}

.manual-group-probe {
  margin-top: 8px;
}

.governance-group-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.mb-12 {
  margin-bottom: 12px;
}

.group-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.group-name {
  font-weight: 600;
  color: #303133;
}

.count {
  color: #606266;
}

.row-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: nowrap;
  overflow-x: auto;
  padding-bottom: 2px;
}

.action-btn {
  min-width: 58px;
  margin-left: 0 !important;
  flex: 0 0 auto;
}

.manual-row-actions {
  flex-wrap: nowrap;
}

.governance-row-actions .action-btn {
  min-width: 72px;
}

.governance-row-actions {
  width: 100%;
  justify-content: flex-end;
}

.publication-row-actions .action-btn {
  min-width: 88px;
}

@media (max-width: 960px) {
  .publication-workbench-meta {
    grid-template-columns: 1fr;
  }

  .publication-runtime-handoff-meta {
    grid-template-columns: 1fr;
  }

  .publication-flow,
  .publication-traceability {
    grid-template-columns: 1fr;
  }

  .publication-batch-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .publication-checklist {
    grid-template-columns: 1fr 1fr;
  }

  .publication-builder-layout {
    grid-template-columns: 1fr;
  }

  .manual-registration-layout {
    grid-template-columns: 1fr;
  }
}

:deep(.delete-action-btn.el-button--danger.is-plain) {
  color: #fff;
  background-color: #d64545;
  border-color: #d64545;
}

:deep(.delete-action-btn.el-button--danger.is-plain:hover),
:deep(.delete-action-btn.el-button--danger.is-plain:focus-visible) {
  color: #fff;
  background-color: #bb2f2f;
  border-color: #bb2f2f;
}

:deep(.governance-probe-btn.el-button--warning.is-plain) {
  color: #8a5300;
  background-color: #fff4d6;
  border-color: #f3d19e;
}

:deep(.governance-probe-btn.el-button--warning.is-plain:hover),
:deep(.governance-probe-btn.el-button--warning.is-plain:focus-visible) {
  color: #6b4000;
  background-color: #ffe7ba;
  border-color: #e6a23c;
}

:deep(.governance-test-btn.el-button--primary.is-plain) {
  color: #1d4ed8;
  background-color: #eff6ff;
  border-color: #93c5fd;
}

:deep(.governance-test-btn.el-button--primary.is-plain:hover),
:deep(.governance-test-btn.el-button--primary.is-plain:focus-visible) {
  color: #1e40af;
  background-color: #dbeafe;
  border-color: #60a5fa;
}

:deep(.governance-readiness-btn.el-button--success.is-plain) {
  color: #166534;
  background-color: #ecfdf3;
  border-color: #86efac;
}

:deep(.governance-readiness-btn.el-button--success.is-plain:hover),
:deep(.governance-readiness-btn.el-button--success.is-plain:focus-visible) {
  color: #14532d;
  background-color: #dcfce7;
  border-color: #4ade80;
}

:deep(.governance-edit-btn.el-button--info.is-plain) {
  color: #374151;
  background-color: #f3f4f6;
  border-color: #d1d5db;
}

:deep(.governance-edit-btn.el-button--info.is-plain:hover),
:deep(.governance-edit-btn.el-button--info.is-plain:focus-visible) {
  color: #1f2937;
  background-color: #e5e7eb;
  border-color: #9ca3af;
}
</style>
