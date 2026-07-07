import { useTalkAuth } from "../../app/auth";
import type { ChannelDto } from "@prymeira-talk/shared";
import {
  Clock3,
  MailPlus,
  Plus,
  RefreshCw,
  Route,
  ShieldCheck,
  Trash2,
  Users
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  apiCreateTeamDepartment,
  apiGetChannels,
  apiGetTeamDepartments,
  apiGetTeamUsers,
  apiInviteTeamMember,
  apiRemoveTeamDepartmentChannelRule,
  apiRemoveTeamDepartmentMember,
  apiUpdateTeamDepartment,
  apiUpdateTeamUserRole,
  apiUpsertTeamDepartmentChannelRule,
  apiUpsertTeamDepartmentMember,
  type TeamDepartmentDto,
  type TeamDepartmentMemberDto,
  type TeamUserDto,
  type TeamUserRole
} from "../../app/api";

const roleLabels: Record<TeamUserRole, string> = {
  owner: "Owner",
  manager: "Manager",
  agent: "Agent"
};

const distributionLabels: Record<TeamDepartmentDto["distributionMode"], string> = {
  manual: "Manual",
  round_robin: "Rodízio",
  least_open: "Menor carga"
};

type BusinessHoursMode = "always_on" | "business";

const businessHoursLabels: Record<BusinessHoursMode, string> = {
  always_on: "24h",
  business: "Comercial"
};

function presenceLabel(value: string | null) {
  const labels: Record<string, string> = {
    online: "Online",
    busy: "Ocupado",
    offline: "Offline"
  };

  return value ? labels[value] ?? value : "Offline";
}

function channelLabel(channel: ChannelDto) {
  return channel.displayName ?? channel.phoneNumber ?? channel.provider;
}

function ruleChannelLabel(rule: TeamDepartmentDto["channelRules"][number]) {
  return rule.channelName ?? rule.channelPhoneNumber ?? rule.channelProvider ?? "Canal";
}

function emptyDepartmentForm() {
  return {
    name: "",
    description: "",
    routingOrder: "0",
    distributionMode: "manual" as TeamDepartmentDto["distributionMode"],
    businessHoursMode: "always_on" as BusinessHoursMode,
    slaFirstResponseMinutes: "",
    slaResolutionMinutes: ""
  };
}

function toDepartmentForm(department: TeamDepartmentDto | null) {
  if (!department) return emptyDepartmentForm();
  const businessHours =
    typeof department.businessHours === "object" && department.businessHours !== null
      ? department.businessHours as { mode?: unknown }
      : {};
  const businessHoursMode: BusinessHoursMode = businessHours.mode === "business" ? "business" : "always_on";

  return {
    name: department.name,
    description: department.description ?? "",
    routingOrder: String(department.routingOrder),
    distributionMode: department.distributionMode,
    businessHoursMode,
    slaFirstResponseMinutes: department.slaFirstResponseMinutes?.toString() ?? "",
    slaResolutionMinutes: department.slaResolutionMinutes?.toString() ?? ""
  };
}

function businessHoursPayload(mode: BusinessHoursMode) {
  return mode === "business"
    ? { mode, timezone: "America/Sao_Paulo", weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" }
    : { mode };
}

export function TeamPage() {
  const { getToken } = useTalkAuth();
  const [users, setUsers] = useState<TeamUserDto[]>([]);
  const [departments, setDepartments] = useState<TeamDepartmentDto[]>([]);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState({ email: "", name: "", role: "member" as "admin" | "member" });
  const [newDepartmentForm, setNewDepartmentForm] = useState(emptyDepartmentForm);
  const [departmentForm, setDepartmentForm] = useState(emptyDepartmentForm);
  const [memberForm, setMemberForm] = useState({
    userId: "",
    role: "agent" as TeamDepartmentMemberDto["role"],
    permissions: {
      view: true,
      reply: true,
      transfer: true,
      close: true
    }
  });
  const [channelRuleForm, setChannelRuleForm] = useState({ channelId: "", enabled: true });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedDepartment = useMemo(
    () => departments.find((department) => department.id === selectedDepartmentId) ?? null,
    [departments, selectedDepartmentId]
  );
  const availableMemberUsers = users.filter(
    (user) => !selectedDepartment?.members.some((member) => member.userId === user.id)
  );
  const availableRuleChannels = channels.filter(
    (channel) => !selectedDepartment?.channelRules.some((rule) => rule.channelId === channel.id)
  );

  async function loadTeam() {
    setIsLoading(true);
    setError(null);

    try {
      const [nextUsers, nextDepartments, nextChannels] = await Promise.all([
        apiGetTeamUsers(getToken),
        apiGetTeamDepartments(getToken),
        apiGetChannels(getToken)
      ]);
      setUsers(nextUsers);
      setDepartments(nextDepartments);
      setChannels(nextChannels);
      setSelectedDepartmentId((current) =>
        nextDepartments.some((department) => department.id === current)
          ? current
          : nextDepartments[0]?.id ?? null
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar equipe.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadTeam();
  }, [getToken]);

  useEffect(() => {
    setDepartmentForm(toDepartmentForm(selectedDepartment));
    setMemberForm((current) => ({
      ...current,
      userId: availableMemberUsers[0]?.id ?? ""
    }));
    setChannelRuleForm((current) => ({
      ...current,
      channelId: availableRuleChannels[0]?.id ?? ""
    }));
  }, [selectedDepartmentId, selectedDepartment, availableMemberUsers.length, availableRuleChannels.length]);

  function updateDepartmentInState(department: TeamDepartmentDto) {
    setDepartments((current) =>
      current.some((item) => item.id === department.id)
        ? current.map((item) => (item.id === department.id ? department : item))
        : [department, ...current]
    );
    setSelectedDepartmentId(department.id);
  }

  async function runTeamAction(action: () => Promise<void>) {
    setIsSaving(true);
    setError(null);
    setNotice(null);

    try {
      await action();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar a equipe.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await runTeamAction(async () => {
      const result = await apiInviteTeamMember(getToken, {
        email: inviteForm.email,
        name: inviteForm.name.trim() || undefined,
        role: inviteForm.role
      });
      setInviteForm({ email: "", name: "", role: "member" });
      setNotice(
        result.status === "active"
          ? "Acesso ao Talk liberado pelo Hub."
          : "Convite registrado no Hub. A pessoa pode entrar no Talk com esse email."
      );
      await loadTeam();
    });
  }

  async function createDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await runTeamAction(async () => {
      const department = await apiCreateTeamDepartment(getToken, {
        name: newDepartmentForm.name,
        description: newDepartmentForm.description.trim() || null,
        routingOrder: Number(newDepartmentForm.routingOrder || 0),
        distributionMode: newDepartmentForm.distributionMode,
        businessHours: businessHoursPayload(newDepartmentForm.businessHoursMode),
        slaFirstResponseMinutes: newDepartmentForm.slaFirstResponseMinutes
          ? Number(newDepartmentForm.slaFirstResponseMinutes)
          : null,
        slaResolutionMinutes: newDepartmentForm.slaResolutionMinutes
          ? Number(newDepartmentForm.slaResolutionMinutes)
          : null
      });

      updateDepartmentInState(department);
      setNewDepartmentForm(emptyDepartmentForm());
      setNotice("Fila criada para o workspace atual.");
    });
  }

  async function saveDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDepartment) return;

    await runTeamAction(async () => {
      const department = await apiUpdateTeamDepartment(getToken, selectedDepartment.id, {
        name: departmentForm.name,
        description: departmentForm.description.trim() || null,
        routingOrder: Number(departmentForm.routingOrder || 0),
        distributionMode: departmentForm.distributionMode,
        businessHours: businessHoursPayload(departmentForm.businessHoursMode),
        slaFirstResponseMinutes: departmentForm.slaFirstResponseMinutes
          ? Number(departmentForm.slaFirstResponseMinutes)
          : null,
        slaResolutionMinutes: departmentForm.slaResolutionMinutes
          ? Number(departmentForm.slaResolutionMinutes)
          : null
      });

      updateDepartmentInState(department);
      setNotice("Fila atualizada.");
    });
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDepartment || !memberForm.userId) return;

    await runTeamAction(async () => {
      const department = await apiUpsertTeamDepartmentMember(getToken, selectedDepartment.id, memberForm);
      updateDepartmentInState(department);
      setNotice("Membro vinculado à fila.");
    });
  }

  async function removeMember(member: TeamDepartmentMemberDto) {
    if (!selectedDepartment) return;

    await runTeamAction(async () => {
      await apiRemoveTeamDepartmentMember(getToken, selectedDepartment.id, member.userId);
      updateDepartmentInState({
        ...selectedDepartment,
        members: selectedDepartment.members.filter((item) => item.userId !== member.userId)
      });
      setNotice("Membro removido da fila.");
    });
  }

  async function addChannelRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDepartment || !channelRuleForm.channelId) return;

    await runTeamAction(async () => {
      const department = await apiUpsertTeamDepartmentChannelRule(getToken, selectedDepartment.id, {
        channelId: channelRuleForm.channelId,
        enabled: channelRuleForm.enabled
      });
      updateDepartmentInState(department);
      setNotice("Regra canal → fila salva.");
    });
  }

  async function removeChannelRule(ruleId: string) {
    if (!selectedDepartment) return;

    await runTeamAction(async () => {
      await apiRemoveTeamDepartmentChannelRule(getToken, ruleId);
      updateDepartmentInState({
        ...selectedDepartment,
        channelRules: selectedDepartment.channelRules.filter((rule) => rule.id !== ruleId)
      });
      setNotice("Regra de canal removida.");
    });
  }

  async function updateRole(userId: string, role: TeamUserRole) {
    await runTeamAction(async () => {
      const user = await apiUpdateTeamUserRole(getToken, userId, { role });
      setUsers((current) => current.map((item) => (item.id === user.id ? user : item)));
      setNotice("Role atualizado.");
    });
  }

  return (
    <section className="module-page team-page" aria-label="Equipe">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Equipe</h1>
        </div>
        <div className="module-header-actions">
          <span className={`status-badge status-badge--${isLoading ? "waiting" : "open"}`}>
            {isLoading ? "Carregando" : `${users.length} usuários`}
          </span>
          <span className="status-badge status-badge--bot">
            <ShieldCheck size={12} />
            Hub scoped
          </span>
          <button className="secondary-button" type="button" onClick={() => void loadTeam()}>
            <RefreshCw size={14} />
            Atualizar
          </button>
        </div>
      </header>

      {error ? <p className="error-note">{error}</p> : null}
      {notice ? <p className="success-note">{notice}</p> : null}

      <div className="team-ops-grid">
        <div className="module-panel team-access-panel">
          <div className="panel-title-row">
            <h2>Convites</h2>
            <span>Prymeira Hub</span>
          </div>
          <form className="team-inline-form" onSubmit={(event) => void handleInvite(event)}>
            <label className="form-field">
              Email
              <input
                autoComplete="email"
                disabled={isSaving}
                onChange={(event) => setInviteForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="ana@empresa.com"
                type="email"
                value={inviteForm.email}
                required
              />
            </label>
            <label className="form-field">
              Nome
              <input
                disabled={isSaving}
                onChange={(event) => setInviteForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Opcional"
                value={inviteForm.name}
              />
            </label>
            <label className="form-field">
              Acesso
              <select
                disabled={isSaving}
                onChange={(event) =>
                  setInviteForm((current) => ({ ...current, role: event.target.value as "admin" | "member" }))
                }
                value={inviteForm.role}
              >
                <option value="member">Atendente</option>
                <option value="admin">Admin do Talk</option>
              </select>
            </label>
            <button className="primary-button" type="submit" disabled={isSaving || !inviteForm.email.trim()}>
              <MailPlus size={16} />
              Convidar
            </button>
          </form>
        </div>

        <div className="module-panel team-users-panel">
          <div className="panel-title-row">
            <h2>Usuários</h2>
            <span>{users.length} registros</span>
          </div>
          <div className="ops-table team-users-table" role="table">
            <div className="ops-table-row team-user-row is-header" role="row">
              <span>Nome</span>
              <span>Presença</span>
              <span>Role</span>
            </div>
            {users.length === 0 ? (
              <div className="empty-state" style={{ padding: "24px" }}>
                <div className="empty-state-icon">
                  <Users size={24} />
                </div>
                <h3>Nenhum usuário</h3>
                <p>Os usuários aparecem quando entram pelo Hub.</p>
              </div>
            ) : null}
            {users.map((user) => (
              <div key={user.id} className="ops-table-row team-user-row" role="row">
                <span className="team-user-cell team-user-name-cell">
                  <em>Usuário</em>
                  <strong>{user.displayName}</strong>
                  <small>{user.clerkUserId}</small>
                </span>
                <span className="team-user-cell">
                  <em>Presença</em>
                  <span className={`status-badge status-badge--${user.presenceState === "online" ? "open" : user.presenceState === "busy" ? "waiting" : "closed"}`}>
                    {presenceLabel(user.presenceState)}
                  </span>
                </span>
                <span className="team-user-cell team-role-cell">
                  <em>Role</em>
                  <select
                    value={user.role}
                    aria-label={`Role de ${user.displayName}`}
                    onChange={(event) => void updateRole(user.id, event.target.value as TeamUserRole)}
                  >
                    {(["owner", "manager", "agent"] as const).map((role) => (
                      <option key={role} value={role}>
                        {roleLabels[role]}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="team-routing-layout">
        <div className="module-panel team-queue-list-panel">
          <div className="panel-title-row">
            <h2>Filas</h2>
            <span>{departments.length} departamentos</span>
          </div>
          <form className="team-create-queue-form" onSubmit={(event) => void createDepartment(event)}>
            <label className="form-field">
              Nome
              <input
                value={newDepartmentForm.name}
                onChange={(event) => setNewDepartmentForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Suporte"
                required
              />
            </label>
            <label className="form-field">
              Distribuição
              <select
                value={newDepartmentForm.distributionMode}
                onChange={(event) =>
                  setNewDepartmentForm((current) => ({
                    ...current,
                    distributionMode: event.target.value as TeamDepartmentDto["distributionMode"]
                  }))
                }
              >
                {Object.entries(distributionLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="form-field">
              Horário
              <select
                value={newDepartmentForm.businessHoursMode}
                onChange={(event) =>
                  setNewDepartmentForm((current) => ({
                    ...current,
                    businessHoursMode: event.target.value as BusinessHoursMode
                  }))
                }
              >
                {Object.entries(businessHoursLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <button className="primary-button" type="submit" disabled={isSaving || !newDepartmentForm.name.trim()}>
              <Plus size={16} />
              Criar fila
            </button>
          </form>

          <div className="team-dept-list">
            {departments.length === 0 ? (
              <p className="list-note">Nenhuma fila criada.</p>
            ) : null}
            {departments.map((department) => (
              <button
                className={`team-dept-row ${department.id === selectedDepartmentId ? "is-selected" : ""}`}
                key={department.id}
                onClick={() => setSelectedDepartmentId(department.id)}
                type="button"
              >
                <span>
                  <strong>{department.name}</strong>
                  <small>{distributionLabels[department.distributionMode]} · {department.members.length} membros</small>
                </span>
                <span className="status-badge status-badge--closed">Ordem {department.routingOrder}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="module-panel team-queue-workbench">
          <div className="panel-title-row">
            <h2>{selectedDepartment ? selectedDepartment.name : "Configuração da fila"}</h2>
            <span>{selectedDepartment ? `${selectedDepartment.channelRules.length} canais` : "Selecione uma fila"}</span>
          </div>

          {selectedDepartment ? (
            <>
              <form className="team-queue-form" onSubmit={(event) => void saveDepartment(event)}>
                <label className="form-field">
                  Nome
                  <input
                    disabled={isSaving}
                    onChange={(event) => setDepartmentForm((current) => ({ ...current, name: event.target.value }))}
                    value={departmentForm.name}
                    required
                  />
                </label>
                <label className="form-field">
                  Descrição
                  <input
                    disabled={isSaving}
                    onChange={(event) => setDepartmentForm((current) => ({ ...current, description: event.target.value }))}
                    value={departmentForm.description}
                    placeholder="Quando usar esta fila"
                  />
                </label>
                <label className="form-field">
                  Distribuição
                  <select
                    disabled={isSaving}
                    onChange={(event) =>
                      setDepartmentForm((current) => ({
                        ...current,
                        distributionMode: event.target.value as TeamDepartmentDto["distributionMode"]
                      }))
                    }
                    value={departmentForm.distributionMode}
                  >
                    {Object.entries(distributionLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  Ordem
                  <input
                    disabled={isSaving}
                    min="0"
                    onChange={(event) => setDepartmentForm((current) => ({ ...current, routingOrder: event.target.value }))}
                    type="number"
                    value={departmentForm.routingOrder}
                  />
                </label>
                <label className="form-field">
                  Horário
                  <select
                    disabled={isSaving}
                    onChange={(event) =>
                      setDepartmentForm((current) => ({
                        ...current,
                        businessHoursMode: event.target.value as BusinessHoursMode
                      }))
                    }
                    value={departmentForm.businessHoursMode}
                  >
                    {Object.entries(businessHoursLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  SLA 1a resposta
                  <input
                    disabled={isSaving}
                    min="1"
                    onChange={(event) =>
                      setDepartmentForm((current) => ({ ...current, slaFirstResponseMinutes: event.target.value }))
                    }
                    placeholder="min"
                    type="number"
                    value={departmentForm.slaFirstResponseMinutes}
                  />
                </label>
                <label className="form-field">
                  SLA resolução
                  <input
                    disabled={isSaving}
                    min="1"
                    onChange={(event) =>
                      setDepartmentForm((current) => ({ ...current, slaResolutionMinutes: event.target.value }))
                    }
                    placeholder="min"
                    type="number"
                    value={departmentForm.slaResolutionMinutes}
                  />
                </label>
                <button className="secondary-button icon-button-label" disabled={isSaving || !departmentForm.name.trim()} type="submit">
                  <Clock3 size={15} />
                  Salvar fila
                </button>
              </form>

              <div className="team-queue-sections">
                <section>
                  <div className="team-subtitle-row">
                    <strong>Membros da fila</strong>
                    <span>{selectedDepartment.members.length}</span>
                  </div>
                  <form className="team-mini-form" onSubmit={(event) => void addMember(event)}>
                    <select
                      disabled={isSaving || availableMemberUsers.length === 0}
                      value={memberForm.userId}
                      onChange={(event) => setMemberForm((current) => ({ ...current, userId: event.target.value }))}
                      aria-label="Usuário"
                    >
                      {availableMemberUsers.map((user) => (
                        <option key={user.id} value={user.id}>{user.displayName}</option>
                      ))}
                    </select>
                    <select
                      disabled={isSaving}
                      value={memberForm.role}
                      onChange={(event) =>
                        setMemberForm((current) => ({
                          ...current,
                          role: event.target.value as TeamDepartmentMemberDto["role"]
                        }))
                      }
                      aria-label="Papel na fila"
                    >
                      <option value="agent">Atendente</option>
                      <option value="supervisor">Supervisor</option>
                    </select>
                    <button className="secondary-button icon-button-label" disabled={isSaving || !memberForm.userId} type="submit">
                      <Plus size={15} />
                      Membro
                    </button>
                  </form>
                  <div className="team-chip-list">
                    {selectedDepartment.members.length === 0 ? <p className="list-note">Sem membros nesta fila.</p> : null}
                    {selectedDepartment.members.map((member) => (
                      <span className="team-chip" key={member.userId}>
                        <strong>{member.displayName ?? member.userId}</strong>
                        <small>{member.role === "supervisor" ? "Supervisor" : "Atendente"} · {presenceLabel(member.presenceState)}</small>
                        <button aria-label="Remover membro" onClick={() => void removeMember(member)} type="button">
                          <Trash2 size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                </section>

                <section>
                  <div className="team-subtitle-row">
                    <strong>Canais que entram aqui</strong>
                    <span>{selectedDepartment.channelRules.length}</span>
                  </div>
                  <form className="team-mini-form" onSubmit={(event) => void addChannelRule(event)}>
                    <select
                      disabled={isSaving || availableRuleChannels.length === 0}
                      value={channelRuleForm.channelId}
                      onChange={(event) => setChannelRuleForm((current) => ({ ...current, channelId: event.target.value }))}
                      aria-label="Canal"
                    >
                      {availableRuleChannels.map((channel) => (
                        <option key={channel.id} value={channel.id}>{channelLabel(channel)}</option>
                      ))}
                    </select>
                    <button className="secondary-button icon-button-label" disabled={isSaving || !channelRuleForm.channelId} type="submit">
                      <Route size={15} />
                      Canal
                    </button>
                  </form>
                  <div className="team-chip-list">
                    {selectedDepartment.channelRules.length === 0 ? <p className="list-note">Sem regra de canal.</p> : null}
                    {selectedDepartment.channelRules.map((rule) => (
                      <span className="team-chip" key={rule.id}>
                        <strong>{ruleChannelLabel(rule)}</strong>
                        <small>{rule.enabled ? "Ativa" : "Inativa"}</small>
                        <button aria-label="Remover regra de canal" onClick={() => void removeChannelRule(rule.id)} type="button">
                          <Trash2 size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                </section>
              </div>
            </>
          ) : (
            <div className="empty-state" style={{ padding: "24px" }}>
              <div className="empty-state-icon">
                <Route size={24} />
              </div>
              <h3>Nenhuma fila selecionada</h3>
              <p>Crie uma fila para configurar membros, canais, distribuição e SLA.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
