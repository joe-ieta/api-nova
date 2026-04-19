<template>
  <div class="api-tester">
    <div class="header-section">
      <div class="header-content">
        <h1>
          <el-icon><Tools /></el-icon>
          {{ t("apiTester.title") }}
        </h1>
        <p class="header-description">
          {{ t("apiTester.description") }}
        </p>
      </div>

      <div class="header-actions">
        <el-button
          type="primary"
          :icon="Plus"
          @click="showCreateTestCaseDialog"
          :disabled="!selectedTool"
        >
          {{ t("apiTester.actions.createTestCase") }}
        </el-button>
        <el-button :icon="Refresh" @click="refreshData" :loading="loading">
          {{ t("apiTester.actions.refresh") }}
        </el-button>
      </div>
    </div>
    <div class="main-content">
      <div class="catalog-panel">
        <div class="panel-header">
          <h3>{{ t("apiTester.catalogTitle") }}</h3>
          <el-input
            v-model="catalogSearchText"
            :placeholder="t('apiTester.searchGroups')"
            :prefix-icon="Search"
            clearable
            size="small"
          />
        </div>

        <div class="catalog-list" v-loading="loadingTools">
          <div class="catalog-section">
            <div class="catalog-section-title">{{ t("apiTester.manualRegistration") }}</div>
            <button
              v-for="group in filteredManualGroups"
              :key="group.groupKey"
              type="button"
              class="catalog-item"
              :class="{ active: selectedGroupKey === group.groupKey }"
              @click="selectCatalogGroup(group.groupKey)"
            >
              <div class="catalog-item-title">{{ group.groupName }}</div>
              <div class="catalog-item-subtitle">{{ group.hostPort }}</div>
              <div class="catalog-item-path">{{ group.basePath }}</div>
              <div class="catalog-item-meta">{{ group.endpoints.length }} ? endpoint</div>
              <div class="catalog-item-progress">
                {{ t("apiTester.progressCompleted", { count: group.completedTests }) }} / {{ group.endpoints.length }}
                <span>{{ t("apiTester.progressPending", { count: group.pendingTests }) }}</span>
                <span>{{ group.progressPercent }}%</span>
              </div>
            </button>
          </div>

          <div class="catalog-section">
            <div class="catalog-section-title">{{ t("apiTester.importedRegistration") }}</div>
            <button
              v-for="group in filteredImportedGroups"
              :key="group.groupKey"
              type="button"
              class="catalog-item"
              :class="{ active: selectedGroupKey === group.groupKey }"
              @click="selectCatalogGroup(group.groupKey)"
            >
              <div class="catalog-item-title">{{ group.groupName }}</div>
              <div class="catalog-item-subtitle">{{ group.hostPort }}</div>
              <div class="catalog-item-path">{{ group.basePath }}</div>
              <div class="catalog-item-meta">{{ group.endpoints.length }} ? endpoint</div>
              <div class="catalog-item-progress">
                {{ t("apiTester.progressCompleted", { count: group.completedTests }) }} / {{ group.endpoints.length }}
                <span>{{ t("apiTester.progressPending", { count: group.pendingTests }) }}</span>
                <span>{{ group.progressPercent }}%</span>
              </div>
            </button>
          </div>

          <div
            v-if="filteredManualGroups.length === 0 && filteredImportedGroups.length === 0"
            class="empty-state"
          >
            <el-empty :description="t('apiTester.noGroups')">
              <el-button type="primary" @click="$router.push('/registration/batch')">
                {{ t("apiTester.goRegistration") }}
              </el-button>
            </el-empty>
          </div>
        </div>
      </div>

      <div class="endpoints-panel">
        <div class="panel-header">
          <h3>{{ selectedGroup ? selectedGroup.groupName : t("apiTester.endpointsTitle") }}</h3>
          <el-input
            v-model="endpointSearchText"
            :placeholder="t('apiTester.searchEndpoints')"
            :prefix-icon="Search"
            clearable
            size="small"
          />
        </div>

        <div class="endpoint-list" v-loading="loadingTools">
          <div v-if="selectedGroup" class="endpoint-group-summary">
            <div class="catalog-item-subtitle">{{ selectedGroup.hostPort }}</div>
            <div class="catalog-item-path">{{ selectedGroup.basePath }}</div>
            <div class="catalog-item-meta">{{ selectedGroup.endpoints.length }} ? endpoint</div>
            <div class="catalog-item-progress">
              {{ t("apiTester.progressCompleted", { count: selectedGroup.completedTests }) }} / {{ selectedGroup.endpoints.length }}
              <span>{{ t("apiTester.progressPending", { count: selectedGroup.pendingTests }) }}</span>
              <span>{{ selectedGroup.progressPercent }}%</span>
            </div>
          </div>

          <button
            v-for="endpoint in filteredSelectedGroupEndpoints"
            :key="endpoint.id"
            type="button"
            class="endpoint-item"
            :class="{ active: selectedEndpointId === endpoint.id }"
            @click="selectEndpoint(endpoint.id)"
          >
            <div class="tool-info">
              <div class="tool-name">{{ endpoint.name }}</div>
              <div class="tool-method">{{ endpoint.method }}</div>
            </div>
            <div class="tool-description">{{ endpoint.path }}</div>
            <div class="endpoint-item-meta">
              <el-tag size="small" :type="getEndpointStatusTagType(endpoint.status)" effect="plain">
                {{ getEndpointStatusLabel(endpoint.status) }}
              </el-tag>
              <el-tag
                size="small"
                :type="getTestStatusTagType(endpoint.testStatus, endpoint.qualificationState)"
                effect="plain"
              >
                {{ getTestStatusLabel(endpoint.testStatus, endpoint.qualificationState) }}
              </el-tag>
            </div>
          </button>

          <div v-if="selectedGroup && filteredSelectedGroupEndpoints.length === 0" class="empty-state">
            <el-empty :description="t('apiTester.noMatchingEndpoints')" />
          </div>

          <div v-if="!selectedGroup" class="empty-state">
            <el-empty :description="t('apiTester.selectGroup')" />
          </div>
        </div>
      </div>

      <div class="testing-panel" v-if="selectedTool">
        <el-tabs v-model="activeTab" class="testing-tabs">
          <el-tab-pane :label="t('apiTester.tabs.manual')" name="manual">
            <div class="manual-test-form">
              <div class="form-header">
                <h4>{{ selectedTool.name }}</h4>
                <el-tag :type="getMethodTagType(selectedTool.method)">
                  {{ selectedTool.method.toUpperCase() }}
                </el-tag>
              </div>

              <div class="tool-description-text">
                {{ selectedTool.description }}
              </div>

              <div class="parameters-section">
                <h5>{{ t("apiTester.requestParameters") }}</h5>
                <el-form
                  ref="parametersFormRef"
                  :model="testParameters"
                  label-width="120px"
                  class="parameters-form"
                >
                  <div v-if="!hasParameters" class="no-parameters">
                    {{ t("apiTester.noParameters") }}
                  </div>

                  <template v-else>
                    <el-form-item
                      v-for="[paramName, paramSchema] in Object.entries(toolParameters)"
                      :key="paramName"
                      :label="paramName"
                      :prop="paramName"
                      :rules="getParameterRules(paramName, paramSchema)"
                    >
                      <div class="parameter-input">
                        <component
                          :is="getParameterComponent(paramSchema.type)"
                          v-model="testParameters[paramName]"
                          :placeholder="getParameterPlaceholder(paramSchema)"
                          :disabled="loading"
                          v-bind="getParameterProps(paramSchema)"
                        />
                        <div class="parameter-info">
                          <span class="parameter-type">{{ paramSchema.type }}</span>
                          <span v-if="isRequired(paramName)" class="required-mark">*</span>
                        </div>
                      </div>
                      <div v-if="paramSchema.description" class="parameter-description">
                        {{ paramSchema.description }}
                      </div>
                    </el-form-item>
                  </template>
                </el-form>
              </div>

              <div class="test-actions">
                <el-button
                  type="primary"
                  size="large"
                  :loading="testing"
                  @click="executeTest"
                  :icon="CaretRight"
                >
                  {{ testing ? t("apiTester.actions.running") : t("apiTester.actions.runTest") }}
                </el-button>
                <el-button @click="resetParameters" :disabled="testing">
                  {{ t("apiTester.actions.resetParameters") }}
                </el-button>
                <el-button @click="fillSampleData" :disabled="testing">
                  {{ t("apiTester.actions.fillSampleData") }}
                </el-button>
              </div>

              <div v-if="testResult" class="result-section">
                <div class="result-header">
                  <h5>{{ t("apiTester.resultTitle") }}</h5>
                  <el-tag :type="testResult.success ? 'success' : 'danger'">
                    {{ testResult.success ? t("apiTester.status.success") : t("apiTester.status.failed") }}
                  </el-tag>
                  <span class="execution-time">
                    {{ t("apiTester.duration") }}: {{ testResult.executionTime }}ms
                  </span>
                </div>

                <div class="result-content">
                  <el-alert
                    v-if="!testResult.success"
                    :title="testResult.error || t('apiTester.messages.executionFailed')"
                    type="error"
                    show-icon
                  />

                  <div v-else class="success-result">
                    <el-input
                      type="textarea"
                      :rows="8"
                      :value="JSON.stringify(testResult.data, null, 2)"
                      readonly
                    />
                  </div>
                </div>

                <div class="result-actions">
                  <el-button size="small" @click="copyResult">
                    <el-icon><CopyDocument /></el-icon>
                    {{ t("apiTester.actions.copyResult") }}
                  </el-button>
                  <el-button size="small" @click="saveAsTestCase" v-if="testResult.success">
                    <el-icon><Plus /></el-icon>
                    {{ t("apiTester.actions.saveAsTestCase") }}
                  </el-button>
                </div>
              </div>
            </div>
          </el-tab-pane>

          <el-tab-pane :label="t('apiTester.tabs.testCases')" name="testcases">
            <div class="test-cases-section">
              <div class="test-cases-header">
                <div class="search-filters">
                  <el-input
                    v-model="testCaseSearchText"
                    :placeholder="t('apiTester.searchTestCases')"
                    :prefix-icon="Search"
                    clearable
                    style="width: 200px"
                  />
                  <el-select
                    v-model="selectedTag"
                    :placeholder="t('apiTester.filterTags')"
                    clearable
                    style="width: 150px"
                  >
                    <el-option
                      v-for="tag in availableTags"
                      :key="tag"
                      :label="tag"
                      :value="tag"
                    />
                  </el-select>
                </div>
              </div>

              <div class="test-cases-list">
                <div
                  v-for="testCase in filteredTestCases"
                  :key="testCase.id"
                  class="test-case-item"
                >
                  <div class="test-case-info">
                    <div class="test-case-name">{{ testCase.name }}</div>
                    <div class="test-case-meta">
                      <el-tag
                        v-for="tag in testCase.tags"
                        :key="tag"
                        size="small"
                        style="margin-right: 4px"
                      >
                        {{ tag }}
                      </el-tag>
                      <span class="test-case-date">
                        {{ formatDate(testCase.createdAt) }}
                      </span>
                    </div>
                  </div>

                  <div class="test-case-actions">
                    <el-button size="small" @click="runTestCase(testCase)">{{ t("apiTester.actions.execute") }}</el-button>
                    <el-button size="small" @click="editTestCase(testCase)">{{ t("apiTester.actions.load") }}</el-button>
                    <el-button size="small" type="danger" @click="deleteTestCase(testCase.id)">
                      {{ t("apiTester.actions.delete") }}
                    </el-button>
                  </div>
                </div>

                <div v-if="filteredTestCases.length === 0" class="empty-state">
                  <el-empty :description="t('apiTester.noTestCases')" />
                </div>
              </div>
            </div>
          </el-tab-pane>

          <el-tab-pane :label="t('apiTester.tabs.history')" name="history">
            <div class="test-history-section">
              <div class="history-list">
                <div
                  v-for="historyItem in recentHistory"
                  :key="historyItem.id"
                  class="history-item"
                >
                  <div class="history-info">
                    <div class="history-tool">
                      {{ getToolName(historyItem.toolId) }}
                    </div>
                    <div class="history-time">
                      {{ formatDateTime(historyItem.timestamp) }}
                    </div>
                  </div>

                  <div class="history-result">
                    <el-tag :type="historyItem.result.success ? 'success' : 'danger'">
                      {{ historyItem.result.success ? t("apiTester.status.success") : t("apiTester.status.failed") }}
                    </el-tag>
                    <span class="execution-time">
                      {{ historyItem.result.executionTime }}ms
                    </span>
                  </div>

                  <div class="history-actions">
                    <el-button size="small" @click="viewHistoryDetails(historyItem)">
                      {{ t("apiTester.actions.viewDetail") }}
                    </el-button>
                    <el-button size="small" @click="rerunFromHistory(historyItem)">
                      {{ t("apiTester.actions.rerun") }}
                    </el-button>
                  </div>
                </div>

                <div v-if="recentHistory.length === 0" class="empty-state">
                  <el-empty :description="t('apiTester.noHistory')" />
                </div>
              </div>
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>

      <div v-else class="no-tool-selected">
        <el-empty :description="t('apiTester.selectEndpoint')" />
      </div>
    </div>
    <el-dialog
      v-model="createTestCaseDialogVisible"
      title="创建测试用例"
      width="500px"
      :close-on-click-modal="false"
    >
      <el-form
        ref="createTestCaseFormRef"
        :model="newTestCase"
        label-width="80px"
        :rules="testCaseRules"
      >
        <el-form-item label="名称" prop="name">
          <el-input v-model="newTestCase.name" placeholder="输入测试用例名称" />
        </el-form-item>

        <el-form-item label="标签" prop="tags">
          <el-input v-model="tagsInput" placeholder="输入标签，用逗号分隔" />
        </el-form-item>

        <el-form-item label="期望结果">
          <el-input
            type="textarea"
            v-model="newTestCase.expectedResult"
            placeholder="描述期望的测试结果（可选）"
            :rows="3"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="createTestCaseDialogVisible = false"
            >取消</el-button
          >
          <el-button type="primary" @click="createTestCase">创建</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 历史详情对话框 -->
    <el-dialog
      v-model="historyDetailsDialogVisible"
      title="测试历史详情"
      width="600px"
    >
      <div v-if="selectedHistoryItem" class="history-details">
        <div class="detail-section">
          <h4>基本信息</h4>
          <div class="detail-content">
            <p>
              <strong>工具:</strong>
              {{ getToolName(selectedHistoryItem.toolId) }}
            </p>
            <p>
              <strong>时间:</strong>
              {{ formatDateTime(selectedHistoryItem.timestamp) }}
            </p>
            <p>
              <strong>状态:</strong>
              <el-tag
                :type="
                  selectedHistoryItem.result.success ? 'success' : 'danger'
                "
              >
                {{ selectedHistoryItem.result.success ? "成功" : "失败" }}
              </el-tag>
            </p>
            <p>
              <strong>执行时间:</strong>
              {{ selectedHistoryItem.result.executionTime }}ms
            </p>
          </div>
        </div>

        <div class="detail-section">
          <h4>参数</h4>
          <el-input
            type="textarea"
            :value="JSON.stringify(selectedHistoryItem.parameters, null, 2)"
            readonly
            :rows="4"
          />
        </div>

        <div class="detail-section">
          <h4>结果</h4>
          <el-input
            type="textarea"
            :value="
              selectedHistoryItem.result.success
                ? JSON.stringify(selectedHistoryItem.result.data, null, 2)
                : selectedHistoryItem.result.error
            "
            readonly
            :rows="6"
          />
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from "vue";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { Tools, Plus, Refresh, Search, CaretRight, CopyDocument } from "@element-plus/icons-vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";

import { useTestingStore } from "@/stores/testing";
import type { MCPTool, TestCase, ToolResult } from "@/types";
import { serverAPI } from "@/services/api";
import { useConfirmation } from "@/composables/useConfirmation";
import { usePerformanceMonitor } from "@/composables/usePerformance";

const testingStore = useTestingStore();
const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();

const { confirmDelete: globalConfirmDelete } = useConfirmation();
const { measureFunction } = usePerformanceMonitor();

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

type EndpointCatalogEndpoint = {
  id: string;
  groupKey: string;
  sourceType: "manual" | "imported";
  sourceServiceAssetId: string;
  name: string;
  method: string;
  path: string;
  status: string;
  testStatus: string;
  qualificationState: string;
  description: string;
  baseUrl: string;
};

type EndpointCatalogGroup = {
  groupKey: string;
  sourceType: "manual" | "imported";
  groupName: string;
  baseUrl: string;
  hostPort: string;
  basePath: string;
  completedTests: number;
  pendingTests: number;
  progressPercent: number;
  endpoints: EndpointCatalogEndpoint[];
};

const loading = ref(false);
const loadingTools = ref(false);
const testing = ref(false);
const activeTab = ref("manual");
const endpointAssetTool = ref<MCPTool | null>(null);
const endpointAssetId = ref("");
const endpointTestingState = ref<any>(null);
const selectedTool = ref<MCPTool | null>(null);
const selectedGroupKey = ref("");
const selectedEndpointId = ref("");
const catalogSearchText = ref("");
const endpointSearchText = ref("");
const catalogGroups = ref<EndpointCatalogGroup[]>([]);
const toolCache = ref<Record<string, MCPTool>>({});

const testParameters = ref<Record<string, any>>({});
const testResult = ref<ToolResult | null>(null);
const parametersFormRef = ref<FormInstance>();

const createTestCaseDialogVisible = ref(false);
const newTestCase = ref({
  name: "",
  expectedResult: "",
  tags: [] as string[],
});
const tagsInput = ref("");
const createTestCaseFormRef = ref<FormInstance>();
const testCaseSearchText = ref("");
const selectedTag = ref("");

const historyDetailsDialogVisible = ref(false);
const selectedHistoryItem = ref<any>(null);

const getGroupHostPort = (sourceAsset?: SourceServiceAssetRecord, baseUrl?: string): string => {
  if (sourceAsset?.host) {
    return sourceAsset.port ? `${sourceAsset.host}:${sourceAsset.port}` : sourceAsset.host;
  }
  if (!baseUrl) return "-";
  try {
    const parsed = new URL(baseUrl);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return baseUrl;
  }
};

const getGroupBasePath = (sourceAsset?: SourceServiceAssetRecord): string =>
  sourceAsset?.normalizedBasePath || "/";

const isEndpointTestCompleted = (endpoint: EndpointCatalogEndpoint): boolean =>
  endpoint.testStatus !== "untested";

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

const mapEndpointCatalogEndpoint = (
  endpoint: EndpointAssetRecord,
  sourceAsset?: SourceServiceAssetRecord,
): EndpointCatalogEndpoint => {
  const metadata = (endpoint.metadata || {}) as Record<string, any>;
  const sourceType = metadata.source === "manual-registration" ? "manual" : "imported";
  const baseUrl = deriveBaseUrlFromAsset(sourceAsset);
  return {
    id: endpoint.id,
    groupKey: endpoint.sourceServiceAssetId || `${sourceType}:${baseUrl}`,
    sourceType,
    sourceServiceAssetId: endpoint.sourceServiceAssetId,
    name: String(metadata.displayName || sourceAsset?.displayName || endpoint.summary || endpoint.path),
    method: String(endpoint.method || "GET").toUpperCase(),
    path: endpoint.path,
    status: endpoint.status || "draft",
    testStatus: String(metadata.testStatus || "untested"),
    qualificationState: String(metadata.qualificationState || "registered"),
    description: endpoint.description || `${endpoint.method || "GET"} ${endpoint.path}`,
    baseUrl,
  };
};

const buildCatalogGroups = (
  endpoints: EndpointAssetRecord[],
  sourceAssets: SourceServiceAssetRecord[],
): EndpointCatalogGroup[] => {
  const sourceMap = new Map(sourceAssets.map((item) => [item.id, item]));
  const groupMap = new Map<string, EndpointCatalogGroup>();

  endpoints.forEach((endpoint) => {
    const sourceAsset = sourceMap.get(endpoint.sourceServiceAssetId);
    const mapped = mapEndpointCatalogEndpoint(endpoint, sourceAsset);
    const key = mapped.groupKey;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        groupKey: key,
        sourceType: mapped.sourceType,
        groupName: sourceAsset?.displayName || mapped.name || mapped.baseUrl,
        baseUrl: mapped.baseUrl,
        hostPort: getGroupHostPort(sourceAsset, mapped.baseUrl),
        basePath: getGroupBasePath(sourceAsset),
        completedTests: 0,
        pendingTests: 0,
        progressPercent: 0,
        endpoints: [],
      });
    }
    groupMap.get(key)!.endpoints.push(mapped);
  });

  return Array.from(groupMap.values())
    .map((group) => ({
      ...group,
      endpoints: group.endpoints.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`)),
      completedTests: group.endpoints.filter((endpoint) => isEndpointTestCompleted(endpoint)).length,
      pendingTests: group.endpoints.filter((endpoint) => !isEndpointTestCompleted(endpoint)).length,
      progressPercent: group.endpoints.length
        ? Math.round(
            (group.endpoints.filter((endpoint) => isEndpointTestCompleted(endpoint)).length /
              group.endpoints.length) *
              100,
          )
        : 0,
    }))
    .sort((a, b) => `${a.sourceType}:${a.groupName}:${a.baseUrl}`.localeCompare(`${b.sourceType}:${b.groupName}:${b.baseUrl}`));
};

const filteredGroups = computed(() => {
  const keyword = catalogSearchText.value.trim().toLowerCase();
  if (!keyword) return catalogGroups.value;
  return catalogGroups.value.filter((group) =>
    [group.groupName, group.baseUrl].some((value) => value.toLowerCase().includes(keyword)),
  );
});

const filteredManualGroups = computed(() =>
  filteredGroups.value.filter((group) => group.sourceType === "manual"),
);
const filteredImportedGroups = computed(() =>
  filteredGroups.value.filter((group) => group.sourceType === "imported"),
);

const selectedGroup = computed(() =>
  filteredGroups.value.find((group) => group.groupKey === selectedGroupKey.value) || null,
);

const filteredSelectedGroupEndpoints = computed(() => {
  if (!selectedGroup.value) return [] as EndpointCatalogEndpoint[];
  const keyword = endpointSearchText.value.trim().toLowerCase();
  if (!keyword) return selectedGroup.value.endpoints;
  return selectedGroup.value.endpoints.filter((endpoint) =>
    [endpoint.name, endpoint.method, endpoint.path, endpoint.status, endpoint.testStatus]
      .some((value) => String(value).toLowerCase().includes(keyword)),
  );
});

const toolParameters = computed(() => {
  if (!selectedTool.value?.parameters?.properties) return {};
  return selectedTool.value.parameters.properties;
});

const hasParameters = computed(() => Object.keys(toolParameters.value).length > 0);

const testCases = computed(() => {
  if (!selectedTool.value) return [];
  return testingStore.getTestCasesByTool(selectedTool.value.id);
});

const filteredTestCases = computed(() => {
  let filtered = testCases.value;
  if (testCaseSearchText.value) {
    const searchLower = testCaseSearchText.value.toLowerCase();
    filtered = filtered.filter((tc) => tc.name.toLowerCase().includes(searchLower));
  }
  if (selectedTag.value) {
    filtered = filtered.filter((tc) => tc.tags.includes(selectedTag.value));
  }
  return filtered;
});

const availableTags = computed(() => {
  const tags = new Set<string>();
  testCases.value.forEach((tc) => tc.tags.forEach((tag) => tags.add(tag)));
  return Array.from(tags);
});

const recentHistory = computed(() => testingStore.getRecentTestHistory(20));

const knownTools = computed(() => {
  const values = Object.values(toolCache.value);
  if (selectedTool.value && !toolCache.value[selectedTool.value.id]) {
    return [selectedTool.value, ...values];
  }
  return values;
});

const testCaseRules: FormRules = {
  name: [
    { required: true, message: "Please enter a test case name", trigger: "blur" },
    { min: 2, max: 50, message: "Length must be between 2 and 50 characters", trigger: "blur" },
  ],
};

const toPropertySchema = (schema: any): any => {
  if (!schema || typeof schema !== "object") {
    return { type: "string" };
  }

  const schemaType = schema.type || "string";
  const normalized: Record<string, any> = {
    type: schemaType,
    description: schema.description,
    format: schema.format,
    enum: schema.enum,
    default: schema.default,
    minimum: schema.minimum,
    maximum: schema.maximum,
    minLength: schema.minLength,
    maxLength: schema.maxLength,
    pattern: schema.pattern,
  };

  if (schemaType === "array" && schema.items) {
    normalized.items = toPropertySchema(schema.items);
  }
  if (schemaType === "object" && schema.properties) {
    normalized.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toPropertySchema(value)]),
    );
    normalized.required = Array.isArray(schema.required) ? schema.required : [];
  }

  return normalized;
};

const buildToolFromEndpointAsset = (detail: any): MCPTool => {
  const endpoint = detail?.endpoint || {};
  const rawOperation = endpoint.rawOperation || {};
  const rawParameters = Array.isArray(rawOperation.parameters) ? rawOperation.parameters : [];
  const properties: Record<string, any> = {};
  const required = new Set<string>();

  const pathMatches = String(endpoint.path || "").matchAll(/\{([^}]+)\}/g);
  for (const match of pathMatches) {
    const name = match[1];
    properties[name] = { type: "string", description: `Path parameter: ${name}` };
    required.add(name);
  }

  rawParameters.forEach((param: any) => {
    const name = param?.name;
    if (!name) return;
    properties[name] = {
      type: param?.schema?.type || "string",
      description: param?.description || `${param?.in || "query"} parameter`,
    };
    if (param?.required) {
      required.add(name);
    }
  });

  const requestBodySchema = rawOperation?.requestBody?.content?.["application/json"]?.schema || null;
  if (requestBodySchema?.properties) {
    Object.entries(requestBodySchema.properties).forEach(([name, schema]) => {
      properties[name] = toPropertySchema(schema);
    });
    (requestBodySchema.required || []).forEach((name: string) => required.add(name));
  }

  return {
    id: `endpoint-asset:${endpoint.id}`,
    name: endpoint.summary || `${endpoint.method} ${endpoint.path}`,
    description: endpoint.description || `Endpoint asset ${endpoint.method} ${endpoint.path}`,
    parameters: { type: "object", properties, required: Array.from(required) },
    serverId: endpoint.id,
    endpoint: endpoint.path,
    method: endpoint.method || "GET",
    path: endpoint.path,
  };
};

const resetParameters = () => {
  testParameters.value = {};
  Object.entries(toolParameters.value).forEach(([name, schema]) => {
    testParameters.value[name] = getDefaultValue(schema);
  });
};

const loadEndpointAssetTestingContext = async (endpointId: string) => {
  const detail = await serverAPI.getEndpointAssetDetails(endpointId);
  endpointAssetId.value = endpointId;
  endpointAssetTool.value = buildToolFromEndpointAsset(detail);
  endpointTestingState.value = await serverAPI.getEndpointAssetTestingState(endpointId);
  selectedTool.value = endpointAssetTool.value;
  toolCache.value = {
    ...toolCache.value,
    [endpointAssetTool.value.id]: endpointAssetTool.value,
  };
  resetParameters();
  testResult.value = null;
};

const selectCatalogGroup = async (groupKey: string) => {
  selectedGroupKey.value = groupKey;
  endpointSearchText.value = "";
  selectedEndpointId.value = "";
  endpointAssetId.value = "";
  endpointAssetTool.value = null;
  endpointTestingState.value = null;
  selectedTool.value = null;
  testResult.value = null;
  await router.replace({
    query: {
      ...route.query,
      endpointId: undefined,
    },
  });
};

const selectEndpoint = async (endpointId: string) => {
  selectedEndpointId.value = endpointId;
  await router.replace({
    query: {
      ...route.query,
      endpointId,
    },
  });
  await loadEndpointAssetTestingContext(endpointId);
};

const syncSelectionWithCatalog = async (endpointId?: string) => {
  const allGroups = catalogGroups.value;
  if (allGroups.length === 0) {
    selectedGroupKey.value = "";
    selectedEndpointId.value = "";
    selectedTool.value = null;
    endpointAssetTool.value = null;
    endpointTestingState.value = null;
    endpointAssetId.value = "";
    return;
  }

  if (endpointId) {
    const matchedGroup = allGroups.find((group) => group.endpoints.some((item) => item.id === endpointId));
    if (matchedGroup) {
      selectedGroupKey.value = matchedGroup.groupKey;
      selectedEndpointId.value = endpointId;
      await loadEndpointAssetTestingContext(endpointId);
      return;
    }
  }

  if (!allGroups.some((group) => group.groupKey === selectedGroupKey.value)) {
    selectedGroupKey.value = allGroups[0].groupKey;
  }

  if (
    selectedEndpointId.value &&
    !allGroups.some((group) => group.endpoints.some((item) => item.id === selectedEndpointId.value))
  ) {
    selectedEndpointId.value = "";
    selectedTool.value = null;
    endpointAssetTool.value = null;
    endpointTestingState.value = null;
    endpointAssetId.value = "";
  }
};

const loadCatalogData = async (endpointId?: string) => {
  const [endpointResult, sourceResult] = await Promise.all([
    serverAPI.listEndpointAssets(),
    serverAPI.listSourceServiceAssets(),
  ]);
  const endpoints = Array.isArray(endpointResult?.data) ? (endpointResult.data as EndpointAssetRecord[]) : [];
  const sourceAssets = Array.isArray(sourceResult?.data) ? (sourceResult.data as SourceServiceAssetRecord[]) : [];
  catalogGroups.value = buildCatalogGroups(endpoints, sourceAssets);
  await syncSelectionWithCatalog(endpointId);
};

const getDefaultValue = (schema: any): any => {
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return schema.minimum || 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "";
  }
};

const getSampleValue = (schema: any): any => {
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case "string":
      if (schema.enum) return schema.enum[0];
      if (schema.format === "email") return "test@example.com";
      if (schema.format === "date") return new Date().toISOString().split("T")[0];
      if (schema.format === "date-time") return new Date().toISOString();
      return "sample text";
    case "number":
      return schema.minimum || 123.45;
    case "integer":
      return schema.minimum || 123;
    case "boolean":
      return true;
    case "array":
      return ["sample item"];
    case "object":
      return { key: "value" };
    default:
      return "sample";
  }
};

const executeTest = async () => {
  if (!selectedTool.value || !endpointAssetId.value) return;
  if (parametersFormRef.value) {
    const valid = await parametersFormRef.value.validate().catch(() => false);
    if (!valid) {
      ElMessage.error(t("apiTester.messages.parameterInvalid"));
      return;
    }
  }

  testing.value = true;
  testResult.value = null;
  try {
    const result = await measureFunction("executeTest", async () => {
      const response = await serverAPI.executeEndpointAssetTest(endpointAssetId.value, {
        parameters: testParameters.value,
      });
      endpointTestingState.value = response.testingState;
      return {
        success: response.test.passed,
        data: response.test.passed
          ? {
              httpStatus: response.test.httpStatus,
              method: response.test.method,
              url: response.test.url,
              qualificationState: response.testingState.qualificationState,
            }
          : undefined,
        error: response.test.errorMessage,
        executionTime: response.test.durationMs,
        timestamp: new Date(),
      } as ToolResult;
    });
    testResult.value = result;
    await loadCatalogData(endpointAssetId.value);
    ElMessage.success(
      result.success
        ? t("apiTester.messages.testCompleted")
        : t("apiTester.messages.testFailed", { reason: result.error || "-" }),
    );
  } catch (error) {
    ElMessage.error(t("apiTester.messages.executeError", { reason: String(error) }));
  } finally {
    testing.value = false;
  }
};

const getParameterComponent = (type: string) => {
  switch (type) {
    case "boolean":
      return "el-switch";
    case "number":
    case "integer":
      return "el-input-number";
    default:
      return "el-input";
  }
};

const getParameterProps = (schema: any) => {
  const props: any = {};
  if (schema.type === "number" || schema.type === "integer") {
    if (schema.minimum !== undefined) props.min = schema.minimum;
    if (schema.maximum !== undefined) props.max = schema.maximum;
    if (schema.type === "integer") props.precision = 0;
  }
  if (schema.type === "string") {
    if (schema.minLength !== undefined) props.minlength = schema.minLength;
    if (schema.maxLength !== undefined) props.maxlength = schema.maxLength;
  }
  return props;
};

const getParameterPlaceholder = (schema: any): string => {
  if (schema.description) return schema.description;
  if (schema.example) return `Example: ${schema.example}`;
  switch (schema.type) {
    case "string":
      return "Please enter a string";
    case "number":
      return "Please enter an integer";
    case "integer":
      return "Please enter an integer";
    case "boolean":
      return "Please enter a value";
    default:
      return "Please enter a value";
  }
};

const getParameterRules = (paramName: string, schema: any) => {
  const rules: any[] = [];
  if (isRequired(paramName)) {
    rules.push({ required: true, message: `${paramName} is required`, trigger: "blur" });
  }
  if (schema.type === "string" && schema.minLength) {
    rules.push({ min: schema.minLength, message: `At least ${schema.minLength} characters`, trigger: "blur" });
  }
  if (schema.type === "string" && schema.maxLength) {
    rules.push({ max: schema.maxLength, message: `At most ${schema.maxLength} characters`, trigger: "blur" });
  }
  return rules;
};

const isRequired = (paramName: string): boolean => {
  return selectedTool.value?.parameters?.required?.includes(paramName) || false;
};

const getMethodTagType = (method: string) => {
  const types: Record<string, string> = {
    GET: "success",
    POST: "primary",
    PUT: "warning",
    DELETE: "danger",
    PATCH: "info",
  };
  return types[method.toUpperCase()] || "info";
};

const getEndpointStatusLabel = (status: string): string => {
  const labels: Record<string, string> = {
    draft: "草稿",
    ready: "就绪",
    verified: "已校验",
    active: "启用",
    published: "已发布",
    degraded: "异常",
    offline: "已下线",
    disabled: "已禁用",
    retired: "已退役",
    archived: "已归档",
  };
  return labels[String(status || "").toLowerCase()] || status || "未知状态";
};

const getEndpointStatusTagType = (status: string): string => {
  const types: Record<string, string> = {
    draft: "info",
    ready: "primary",
    verified: "primary",
    active: "success",
    published: "success",
    degraded: "danger",
    offline: "warning",
    disabled: "danger",
    retired: "info",
    archived: "info",
  };
  return types[String(status || "").toLowerCase()] || "info";
};

const getTestStatusLabel = (testStatus: string, qualificationState?: string): string => {
  const normalizedTestStatus = String(testStatus || "").toLowerCase();
  const normalizedQualification = String(qualificationState || "").toLowerCase();
  if (normalizedQualification === "tested") {
    return normalizedTestStatus === "passed" ? "已测试（通过）" : "已测试";
  }
  if (normalizedQualification === "test_blocked") {
    return normalizedTestStatus === "failed" ? "测试阻塞（未通过）" : "测试阻塞";
  }
  if (normalizedTestStatus === "passed") return "已测试（通过）";
  if (normalizedTestStatus === "failed") return "测试阻塞（未通过）";
  return "未测试";
};

const getTestStatusTagType = (testStatus: string, qualificationState?: string): string => {
  const normalized = String(testStatus || "").toLowerCase();
  const normalizedQualification = String(qualificationState || "").toLowerCase();
  if (normalizedQualification === "tested") return "success";
  if (normalizedQualification === "test_blocked") return "danger";
  if (normalized === "passed") return "success";
  if (normalized === "failed") return "danger";
  return "info";
};

const copyResult = async () => {
  if (!testResult.value) return;
  const text = testResult.value.success
    ? JSON.stringify(testResult.value.data, null, 2)
    : testResult.value.error || t("apiTester.messages.executionFailed");
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(t("apiTester.messages.resultCopied"));
  } catch {
    ElMessage.error(t("apiTester.messages.copyFailed"));
  }
};

const fillSampleData = () => {
  Object.entries(toolParameters.value).forEach(([name, schema]) => {
    testParameters.value[name] = getSampleValue(schema);
  });
  ElMessage.success(t("apiTester.messages.sampleFilled"));
};

const saveAsTestCase = () => {
  if (!selectedTool.value || !testResult.value?.success) return;
  newTestCase.value = {
    name: `${selectedTool.value.name} ${t("apiTester.naming.testCaseSuffix")}`,
    expectedResult: JSON.stringify(testResult.value.data, null, 2),
    tags: [selectedTool.value.method.toUpperCase(), "from-manual-test"],
  };
  tagsInput.value = newTestCase.value.tags.join(", ");
  createTestCaseDialogVisible.value = true;
};

const showCreateTestCaseDialog = () => {
  if (!selectedTool.value) return;
  const template = testingStore.generateTestCaseTemplate(selectedTool.value);
  newTestCase.value = {
    name: template.name || "",
    expectedResult: "",
    tags: template.tags || [],
  };
  tagsInput.value = newTestCase.value.tags.join(", ");
  createTestCaseDialogVisible.value = true;
};

const createTestCase = async () => {
  if (!createTestCaseFormRef.value || !selectedTool.value) return;
  const valid = await createTestCaseFormRef.value.validate().catch(() => false);
  if (!valid) return;
  const tags = tagsInput.value.split(",").map((tag) => tag.trim()).filter(Boolean);
  testingStore.createTestCase({
    name: newTestCase.value.name,
    toolId: selectedTool.value.id,
    parameters: { ...testParameters.value },
    expectedResult: newTestCase.value.expectedResult || undefined,
    tags,
  });
  createTestCaseDialogVisible.value = false;
  newTestCase.value = { name: "", expectedResult: "", tags: [] };
  tagsInput.value = "";
};

const runTestCase = async (testCase: TestCase) => {
  if (!selectedTool.value) return;
  testParameters.value = { ...testCase.parameters };
  await nextTick();
  await executeTest();
};

const editTestCase = (testCase: TestCase) => {
  testParameters.value = { ...testCase.parameters };
  activeTab.value = "manual";
  ElMessage.info(t("apiTester.messages.testCaseLoaded"));
};

const deleteTestCase = async (testCaseId: string) => {
  const testCase = testingStore.testCases.find((tc) => tc.id === testCaseId);
  const testCaseName = testCase?.name || t("apiTester.naming.fallbackTestCase");
  const confirmed = await globalConfirmDelete(testCaseName);
  if (!confirmed) return;
  try {
    testingStore.deleteTestCase(testCaseId);
    ElMessage.success(t("apiTester.messages.testCaseDeleted"));
  } catch (error) {
    ElMessage.error(t("apiTester.messages.deleteFailed", { reason: String(error) }));
  }
};

const viewHistoryDetails = (historyItem: any) => {
  selectedHistoryItem.value = historyItem;
  historyDetailsDialogVisible.value = true;
};

const rerunFromHistory = async (historyItem: any) => {
  const tool = knownTools.value.find((t: MCPTool) => t.id === historyItem.toolId);
  if (!tool) {
    ElMessage.error(t("apiTester.messages.historyContextMissing"));
    return;
  }
  selectedTool.value = tool;
  testParameters.value = { ...historyItem.parameters };
  activeTab.value = "manual";
  await nextTick();
  await executeTest();
};

const getToolName = (toolId: string): string => {
  const tool = knownTools.value.find((t: MCPTool) => t.id === toolId);
  return tool?.name || t("apiTester.messages.unknownEndpoint");
};

const formatDate = (date: Date): string => {
  return new Intl.DateTimeFormat(locale.value || "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(date));
};

const formatDateTime = (date: Date): string => {
  return new Intl.DateTimeFormat(locale.value || "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(date));
};

const refreshData = async () => {
  loading.value = true;
  try {
    const endpointId = typeof route.query.endpointId === "string" ? route.query.endpointId : undefined;
    await loadCatalogData(endpointId);
    ElMessage.success(t("apiTester.messages.catalogRefreshed"));
  } catch {
    ElMessage.error(t("apiTester.messages.refreshFailed"));
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  loadingTools.value = true;
  try {
    const endpointId = typeof route.query.endpointId === "string" ? route.query.endpointId : undefined;
    await loadCatalogData(endpointId);
  } catch {
    ElMessage.error(t("apiTester.messages.loadCatalogFailed"));
  } finally {
    loadingTools.value = false;
  }
});

watch(
  () => route.query.endpointId,
  async (endpointId) => {
    if (typeof endpointId === "string" && endpointId) {
      await loadCatalogData(endpointId);
      return;
    }
    selectedEndpointId.value = "";
    endpointAssetId.value = "";
    endpointAssetTool.value = null;
    endpointTestingState.value = null;
    selectedTool.value = null;
    testResult.value = null;
  },
);
</script>

<style scoped>
.api-tester {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 20px;
  background-color: var(--el-bg-color-page);
}

.header-section {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--el-border-color-light);
}

.header-content h1 {
  margin: 0 0 8px 0;
  color: var(--el-text-color-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 24px;
  font-weight: 600;
}

.header-description {
  margin: 0;
  color: var(--el-text-color-regular);
  font-size: 14px;
}

.header-actions {
  display: flex;
  gap: 12px;
}

.main-content {
  flex: 1;
  display: flex;
  gap: 20px;
  min-height: 0;
}

.catalog-panel,
.endpoints-panel {
  width: 300px;
  background: white;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.panel-header {
  margin-bottom: 16px;
}

.panel-header h3 {
  margin: 0 0 12px 0;
  color: var(--el-text-color-primary);
  font-size: 16px;
  font-weight: 600;
}

.catalog-list,
.endpoint-list {
  flex: 1;
  overflow-y: auto;
}

.catalog-item,
.endpoint-item {
  width: 100%;
  text-align: left;
  padding: 12px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.2s;
  background: white;
}

.catalog-item:hover,
.endpoint-item:hover {
  border-color: var(--el-color-primary);
  background-color: var(--el-color-primary-light-9);
}

.catalog-item.active,
.endpoint-item.active {
  border-color: var(--el-color-primary);
  background-color: var(--el-color-primary-light-8);
}

.catalog-section + .catalog-section {
  margin-top: 16px;
}

.catalog-section-title {
  margin: 0 0 10px 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--el-text-color-secondary);
  text-transform: uppercase;
}

.catalog-item-title {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.catalog-item-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  word-break: break-all;
}

.catalog-item-path {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-family: var(--el-font-family-monospace, Consolas, "Courier New", monospace);
  word-break: break-all;
}

.catalog-item-meta,
.endpoint-item-meta {
  margin-top: 8px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.catalog-item-progress {
  margin-top: 6px;
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--el-color-primary);
}

.endpoint-group-summary {
  margin-bottom: 12px;
  padding: 12px;
  border-radius: 6px;
  background: var(--el-bg-color-page);
}

.tool-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.tool-name {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.tool-method {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
  background-color: var(--el-color-info-light-8);
  color: var(--el-color-info);
  font-weight: 500;
}

.tool-description {
  font-size: 12px;
  color: var(--el-text-color-regular);
  line-height: 1.4;
}

.testing-panel {
  flex: 1;
  background: white;
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  overflow-y: auto;
}

.testing-tabs {
  height: 100%;
}

.manual-test-form {
  max-width: 800px;
}

.form-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.form-header h4 {
  margin: 0;
  color: var(--el-text-color-primary);
  font-size: 18px;
}

.tool-description-text {
  color: var(--el-text-color-regular);
  margin-bottom: 24px;
  padding: 12px;
  background-color: var(--el-bg-color-page);
  border-radius: 6px;
  font-size: 14px;
  line-height: 1.5;
}

.parameters-section h5 {
  margin: 0 0 16px 0;
  color: var(--el-text-color-primary);
  font-size: 16px;
  font-weight: 600;
}

.no-parameters {
  text-align: center;
  color: var(--el-text-color-regular);
  padding: 20px;
  background-color: var(--el-bg-color-page);
  border-radius: 6px;
  font-size: 14px;
}

.parameter-input {
  display: flex;
  align-items: center;
  gap: 8px;
}

.parameter-input > :first-child {
  flex: 1;
}

.parameter-info {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.parameter-type {
  padding: 2px 6px;
  background-color: var(--el-color-info-light-8);
  border-radius: 4px;
}

.required-mark {
  color: var(--el-color-danger);
  font-weight: 600;
}

.parameter-description {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  line-height: 1.4;
}

.test-actions {
  margin: 24px 0;
  display: flex;
  gap: 12px;
}

.result-section {
  margin-top: 24px;
  padding: 16px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background-color: var(--el-bg-color-page);
}

.result-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.result-header h5 {
  margin: 0;
  color: var(--el-text-color-primary);
  font-size: 16px;
  font-weight: 600;
}

.execution-time {
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.result-content {
  margin-bottom: 12px;
}

.result-actions {
  display: flex;
  gap: 8px;
}

.test-cases-section,
.test-history-section {
  max-width: 800px;
}

.test-cases-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.search-filters {
  display: flex;
  gap: 12px;
}

.test-case-item,
.history-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  margin-bottom: 8px;
  background: white;
}

.test-case-info,
.history-info {
  flex: 1;
}

.test-case-name,
.history-tool {
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 4px;
}

.test-case-meta,
.history-time {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.test-case-date {
  margin-left: auto;
}

.test-case-actions,
.history-actions {
  display: flex;
  gap: 8px;
}

.history-result {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 16px;
}

.no-tool-selected {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
}

.history-details .detail-section {
  margin-bottom: 20px;
}

.history-details .detail-section h4 {
  margin: 0 0 8px 0;
  color: var(--el-text-color-primary);
  font-size: 14px;
  font-weight: 600;
}

.history-details .detail-content p {
  margin: 4px 0;
  font-size: 14px;
}

@media (max-width: 768px) {
  .main-content {
    flex-direction: column;
  }

  .catalog-panel,
  .endpoints-panel,
  .testing-panel {
    width: 100%;
  }

  .header-section {
    flex-direction: column;
    gap: 12px;
    align-items: stretch;
  }

  .search-filters {
    flex-direction: column;
  }
}
</style>
